// The page organizer side panel (W6.1, W1.4 section 9). It lists the pages as thumbnails, lets the
// user select some of them, and runs rotate, move and delete on the selection through actions.run.
// Each change is undoable: an info toast offers Undo, which calls actions.undo. The engine is the
// only source of the page order, so the list is read again from session.pages after every change.
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import type { PageRpc } from '../engine/engineConnection';
import type { JobWorker } from '../files/fileJob';
import { FileJobCancelled } from '../files/fileJob';
import { downloadBytes } from '../files/downloads';
import { passwordPrompt, type PasswordPrompt } from '../documents/passwordRequest';
import { reportRpcError, toasts, type ToastStore } from '../feedback/toasts';
import { offerUndo } from '../feedback/undoToast';
import { RpcError } from '../rpc/client';
import { t, tp } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { Panel } from '../layout/Panel';
import { ACCEPT } from '../combine/sources';
import { CachedCanvas } from '../view/pixels';
import { type PlannedRender, RenderScheduler } from '../view/renderScheduler';
import { thumbnailScaleMilli, type ThumbnailSize } from '../view/thumbnails';
import { extractName, runExtract } from './extract';
import { insertFile, insertedCount, PasswordGaveUp } from './insertFile';
import {
  canDelete,
  clampSelection,
  duplicatedPages,
  insertAt,
  insertedSelection,
  movedPages,
  moveTarget,
  NO_SELECTION,
  type PageSelection,
  selectPage,
} from './selection';
import './organizer.css';

// The first pages get the engine's attention before the rest, as the thumbnails panel does.
const VISIBLE_HEAD = 24;

export interface OrganizerPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly onClose: () => void;
  // Called after a change that moves, adds, removes or turns pages, with the new page count, so
  // the document view, the thumbnails panel and the tab's page count drop what they had before.
  readonly onChanged?: (pageCount: number) => void;
  // Where the Undo toasts and the errors go. The app's toast store unless a test passes its own.
  readonly toastStore?: ToastStore;
  // The open document's name, which the extract's download is named after.
  readonly documentName: string;
  // A new job worker for an extract. The app starts the built job worker.
  readonly startWorker: () => JobWorker;
  // Offers the extracted bytes as a file. The default makes a download link.
  readonly download?: (name: string, bytes: ArrayBuffer) => void;
  // Asks for the password of an encrypted file to insert. The app's password dialog unless a test
  // passes its own.
  readonly prompt?: PasswordPrompt;
}

type PageChange =
  'pages.rotate' | 'pages.move' | 'pages.delete' | 'pages.insert_blank' | 'pages.duplicate';

export function OrganizerPanel({
  rpc,
  handle,
  onClose,
  onChanged,
  toastStore = toasts,
  documentName,
  startWorker,
  download = downloadBytes,
  prompt = passwordPrompt,
}: OrganizerPanelProps) {
  const [sizes, setSizes] = useState<readonly ThumbnailSize[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selection, setSelection] = useState<PageSelection>(NO_SELECTION);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A new scheduler after each change: the page indexes now mean other pages, so the cache of the
  // old one is left behind rather than drawn wrongly.
  const [scheduler, setScheduler] = useState(() => new RenderScheduler(rpc, handle));
  const [tick, setTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // Adopts a fresh page list. A move passes the pages it placed, which become the selection.
  const adopt = (pages: readonly ThumbnailSize[], nextSelection?: PageSelection) => {
    setScheduler(new RenderScheduler(rpc, handle));
    setSizes(pages);
    setSelection((current) => clampSelection(nextSelection ?? current, pages.length));
  };

  useEffect(() => {
    let active = true;
    rpc
      .call('session.pages', { handle })
      .then((reply) => {
        if (!active) return;
        setScheduler(new RenderScheduler(rpc, handle));
        setSizes(reply.pages);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [rpc, handle]);

  useEffect(() => scheduler.subscribe(() => setTick((value) => value + 1)), [scheduler]);
  // A replaced or dropped scheduler leaves no thumbnail waiting in its queue.
  useEffect(() => () => scheduler.plan('thumb', []), [scheduler]);

  useEffect(() => {
    if (sizes === null) return;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const planned: PlannedRender[] = sizes.map((size, index) => ({
      page: index,
      scaleMilli: thumbnailScaleMilli(size, devicePixelRatio),
      visible: index < VISIBLE_HEAD,
      distance: index,
    }));
    scheduler.plan('thumb', planned);
  }, [sizes, scheduler, tick]);

  const reportFailure = (error: unknown) => {
    if (error instanceof RpcError) reportRpcError(toastStore, error);
    else toastStore.push('error', t('organizer.failed'));
  };

  // Reads the page list again after a change, or after an undo.
  const reload = async (nextSelection?: PageSelection) => {
    const reply = await rpc.call('session.pages', { handle });
    adopt(reply.pages, nextSelection);
    onChanged?.(reply.pages.length);
  };

  // The Undo offer for one step. It names that step's history, so a press after another change
  // is refused by the engine (the helper says so) instead of undoing the newer step.
  const offerChangeUndo = (message: string, history: number) =>
    offerUndo('info', message, {
      rpc,
      handle,
      history,
      onUndone: () => reload().catch(reportFailure),
      store: toastStore,
    });

  // Runs one page action, refreshes the list and shows the Undo toast. When the engine reports
  // nothing to do (executed false, a move that changes no order), nothing is shown.
  const change = async (
    name: PageChange,
    args: Record<string, unknown>,
    message: string,
    nextSelection: (value: unknown) => PageSelection | undefined,
  ) => {
    setBusy(true);
    try {
      const reply = await rpc.call('actions.run', { handle, name, args });
      if (!reply.executed) return;
      await reload(nextSelection(reply.value));
      offerChangeUndo(message, reply.state.history);
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const picked = selection.picked;
  const total = sizes?.length ?? 0;
  const hasSelection = picked.length > 0;
  const choose = (index: number, modifiers: { ctrl: boolean; shift: boolean }) => {
    setSelection((current) => selectPage(current, index, modifiers));
  };

  const rotate = (delta: number) => {
    const count = picked.length;
    void change(
      'pages.rotate',
      { pages: picked, delta },
      tp('organizer.rotated', count),
      () => undefined,
    );
  };

  const moveSelected = (direction: 'up' | 'down') => {
    const before = moveTarget(direction, picked, total);
    if (before === null) return;
    const count = picked.length;
    void change('pages.move', { pages: picked, before }, tp('organizer.moved', count), (value) => {
      const moved = movedPages(value);
      if (moved === null || moved.length === 0) return undefined;
      return { picked: moved, anchor: moved[0] ?? null };
    });
  };

  // The blank page takes the size of the page before it, and becomes the selection.
  const insertBlank = () => {
    const at = insertAt(picked, total);
    void change('pages.insert_blank', { at }, tp('organizer.inserted', 1), () => ({
      picked: [at],
      anchor: at,
    }));
  };

  // The copies go right after the last chosen page, and they become the selection.
  const duplicateSelected = () => {
    const copies = duplicatedPages(picked);
    const count = picked.length;
    void change('pages.duplicate', { pages: picked }, tp('organizer.duplicated', count), () => ({
      picked: copies,
      anchor: copies[0] ?? null,
    }));
  };

  // Inserts the chosen file in front of the selection's end (or at the end), and selects the pages it
  // brought. The password dialog runs inside insertFile; a cancel there changes nothing.
  const insertFromFile = async (file: File) => {
    const at = insertAt(picked, total);
    setBusy(true);
    try {
      const reply = await insertFile({ rpc, handle, file, at, prompt });
      if (reply === null || !reply.executed) return;
      const count = insertedCount(reply.value);
      await reload(insertedSelection(at, count));
      offerChangeUndo(tp('organizer.inserted', count), reply.state.history);
    } catch (error) {
      if (error instanceof PasswordGaveUp) toastStore.push('error', t('organizer.passwordGaveUp'));
      else reportFailure(error);
    } finally {
      setBusy(false);
    }
  };

  // The chosen pages go to a new file, which is downloaded. Nothing in the document changes, so
  // there is no Undo.
  const extract = async () => {
    const name = extractName(documentName);
    const count = picked.length;
    setBusy(true);
    try {
      const file = await runExtract({ engine: rpc, startWorker }, handle, picked);
      download(name, file.data);
      toastStore.push('info', tp('organizer.extracted', count, { name }));
    } catch (error) {
      if (!(error instanceof FileJobCancelled)) reportFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = () => {
    if (!canDelete(picked, total)) return;
    const count = picked.length;
    void change(
      'pages.delete',
      { pages: picked },
      tp('organizer.deleted', count),
      () => NO_SELECTION,
    );
  };

  if (loadFailed) {
    return (
      <Panel title={t('organizer.title')} onClose={onClose}>
        <p role="alert" className="organizer-status">
          {t('organizer.loadFailed')}
        </p>
      </Panel>
    );
  }

  const devicePixelRatio = window.devicePixelRatio || 1;
  const first = picked[0] ?? 0;
  const last = picked[picked.length - 1] ?? 0;
  const canUp = hasSelection && !busy && first > 0;
  const canDown = hasSelection && !busy && last < total - 1;
  const keepOne = total > 0 && picked.length === total;

  return (
    <Panel title={t('organizer.title')} onClose={onClose}>
      {sizes === null ? (
        <p role="status" className="organizer-status">
          {t('organizer.loading')}
        </p>
      ) : (
        <div className="organizer panel-fill">
          <p className="organizer-status" aria-live="polite">
            {tp('organizer.selected', total, { selected: picked.length, total })}
          </p>
          <div role="toolbar" aria-label={t('organizer.actions')} className="organizer-actions">
            <button type="button" disabled={!hasSelection || busy} onClick={() => rotate(270)}>
              {t('command.rotate-pages-left.label')}
            </button>
            <button type="button" disabled={!hasSelection || busy} onClick={() => rotate(90)}>
              {t('command.rotate-pages-right.label')}
            </button>
            <button type="button" disabled={busy} onClick={insertBlank}>
              {t('organizer.insertBlank')}
            </button>
            <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
              {t('organizer.insertFile')}
            </button>
            <button type="button" disabled={!hasSelection || busy} onClick={duplicateSelected}>
              {t('command.duplicate-pages.label')}
            </button>
            <button type="button" disabled={!hasSelection || busy} onClick={() => void extract()}>
              {t('command.extract-pages.label')}
            </button>
            <button type="button" disabled={!canUp} onClick={() => moveSelected('up')}>
              {t('organizer.moveUp')}
            </button>
            <button type="button" disabled={!canDown} onClick={() => moveSelected('down')}>
              {t('organizer.moveDown')}
            </button>
            <button
              type="button"
              disabled={!canDelete(picked, total) || busy}
              onClick={() => setConfirming(true)}
            >
              {t('command.delete-pages.label')}
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            aria-label={t('organizer.insertFileLabel')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file !== undefined) void insertFromFile(file);
            }}
          />
          {keepOne ? (
            <p className="organizer-status" role="status">
              {t('organizer.keepOne')}
            </p>
          ) : null}
          <div
            role="listbox"
            aria-label={t('organizer.pages')}
            aria-multiselectable="true"
            className="organizer-grid"
            tabIndex={0}
          >
            {sizes.map((size, index) => {
              const selected = picked.includes(index);
              const cacheKey = scheduler.cacheKeyOf(
                'thumb',
                index,
                thumbnailScaleMilli(size, devicePixelRatio),
              );
              return (
                <div
                  key={index}
                  role="option"
                  aria-selected={selected}
                  aria-label={t('organizer.pageNumber', { page: index + 1, total })}
                  tabIndex={0}
                  className="organizer-item"
                  data-selected={selected ? 'true' : 'false'}
                  onClick={(event) =>
                    choose(index, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey })
                  }
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    choose(index, { ctrl: false, shift: false });
                  }}
                >
                  <span className="organizer-thumb">
                    <CachedCanvas
                      cache={scheduler.cache}
                      cacheKey={cacheKey}
                      version={tick}
                      className="organizer-canvas"
                    />
                  </span>
                  <span className="organizer-number">{index + 1}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Overlay
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        title={t('organizer.deleteTitle')}
        showCloseButton={false}
      >
        <p>{tp('organizer.deleteBody', picked.length)}</p>
        <div className="organizer-confirm">
          <Button className="organizer-cancel" onPress={() => setConfirming(false)}>
            {t('organizer.cancel')}
          </Button>
          <Button
            className="organizer-danger"
            onPress={() => {
              setConfirming(false);
              deleteSelected();
            }}
          >
            {t('organizer.deleteConfirm')}
          </Button>
        </div>
      </Overlay>
    </Panel>
  );
}
