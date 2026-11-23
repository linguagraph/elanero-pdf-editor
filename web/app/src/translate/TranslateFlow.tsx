// The translate flow of one open document (W6.6 sections 7 and 8): the selection toolbar, the
// consent notice and the bubble. It is the only place a translation starts, and a translation starts
// only when the user has agreed to the current notice (hasCurrentConsent); otherwise the notice
// opens first and nothing is sent. The App remounts it per tab, so a tab switch closes the bubble.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { readPreferences, writePreferences } from '../prefs/store';
import { SelectionToolbar } from '../text/SelectionToolbar';
import {
  readSelection,
  addTranslationNote,
  copyText,
  type SelectionSnapshot,
  type TranslateCall,
} from './runTranslation';
import { ConsentNotice } from './ConsentNotice';
import { agreedPatch, hasCurrentConsent, type TranslationInfoLoader } from './consent';
import { TranslateBubble } from './TranslateBubble';
import type { DocumentViewHandle } from '../view/DocumentView';
import type { RenderScheduler } from '../view/renderScheduler';
import './translate.css';

export interface TranslateFlowHandle {
  // The palette's Translate selection: the same as the toolbar's Translate button.
  translate(): void;
}

export interface TranslateFlowProps {
  readonly getView: () => DocumentViewHandle | null;
  readonly loadInfo: TranslationInfoLoader;
  readonly translate: TranslateCall;
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
}

export const TranslateFlow = forwardRef<TranslateFlowHandle, TranslateFlowProps>(
  function TranslateFlow({ getView, loadInfo, translate, rpc, handle, scheduler }, ref) {
    const [bubble, setBubble] = useState<SelectionSnapshot | null>(null);
    const [notice, setNotice] = useState<SelectionSnapshot | null>(null);
    const [privacyUrl, setPrivacyUrl] = useState<string | undefined>(undefined);

    const read = useCallback(() => {
      const view = getView();
      return readSelection(
        () => view?.selectedAreas() ?? { state: 'off' },
        window.getSelection(),
        (page) => view?.cachedLines(page),
      );
    }, [getView]);

    // Translation goes ahead only after the notice is agreed to (or was agreed to before).
    const start = useCallback((snapshot: SelectionSnapshot) => {
      const prefs = readPreferences();
      if (prefs.translationEnabled && hasCurrentConsent(prefs)) setBubble(snapshot);
      else setNotice(snapshot);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        translate: () => {
          const snapshot = read();
          if (snapshot === null) toasts.push('info', t('translate.noSelection'));
          else start(snapshot);
        },
      }),
      [read, start],
    );

    // The privacy link comes from translation.info, read when the notice opens (no request is sent).
    useEffect(() => {
      if (notice === null) return undefined;
      let live = true;
      void loadInfo().then(
        (info) => live && setPrivacyUrl(info.services[0]?.privacy_url),
        () => undefined,
      );
      return () => {
        live = false;
      };
    }, [notice, loadInfo]);

    const agree = () => {
      if (notice === null) return;
      writePreferences({ ...readPreferences(), ...agreedPatch() });
      setBubble(notice);
      setNotice(null);
    };

    const closeBubble = useCallback(() => setBubble(null), []);

    return (
      <>
        {bubble === null && notice === null ? (
          <SelectionToolbar read={read} onCopy={copyText} onTranslate={start} />
        ) : null}
        <ConsentNotice
          isOpen={notice !== null}
          privacyUrl={privacyUrl}
          onAgree={agree}
          onCancel={() => setNotice(null)}
        />
        {bubble === null ? null : (
          <TranslateBubble
            snapshot={bubble}
            read={read}
            loadInfo={loadInfo}
            translate={translate}
            onAddNote={(note) => addTranslationNote({ rpc, handle, scheduler }, bubble.areas, note)}
            onClose={closeBubble}
          />
        )}
      </>
    );
  },
);
