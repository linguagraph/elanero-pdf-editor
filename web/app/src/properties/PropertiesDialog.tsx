// The document properties dialog (W7.6): Description (title, author, subject and keywords to edit,
// with the dates, application and producer read-only) and Advanced (the file facts, PDF version
// included), and Fonts (read with session.fonts when the tab is first shown). The values come from
// session.info when the dialog opens; Apply runs one document.set_metadata with the changed fields
// (apply.ts). The Security tab (session.security, read-only) reads when it is first shown.
import { useEffect, useRef, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { toasts, type ToastStore } from '../feedback/toasts';
import { Overlay } from '../layout/Overlay';
import type { DocInfo } from '../rpc/generated';
import { AdvancedPanel } from './AdvancedPanel';
import { applyProperties, loadProperties } from './apply';
import { DescriptionPanel } from './DescriptionPanel';
import { FIELD_LABEL } from './facts';
import { FontsPanel } from './FontsPanel';
import { type FontsState, loadFonts } from './fonts';
import {
  type EditableField,
  type EditableValues,
  editableValues,
  MAX_FIELD_LENGTH,
  overLongFields,
} from './metadata';
import { SecurityPanel, type SecurityTabState } from './SecurityPanel';
import { loadSecurity } from '../security/security';
import './properties.css';

export interface PropertiesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rpc: PageRpc;
  handle: string;
  // The toast store for the info toast and failures. The app's store by default.
  store?: ToastStore;
}

export function PropertiesDialog({
  isOpen,
  onClose,
  rpc,
  handle,
  store = toasts,
}: PropertiesDialogProps) {
  return (
    <Overlay
      isOpen={isOpen}
      onClose={onClose}
      title={t('properties.title')}
      showCloseButton={false}
    >
      <PropertiesBody rpc={rpc} handle={handle} store={store} onDone={onClose} />
    </Overlay>
  );
}

const PROPERTIES_TABS = ['description', 'advanced', 'fonts', 'security'] as const;
type PropertiesTab = (typeof PROPERTIES_TABS)[number];

interface BodyProps {
  rpc: PageRpc;
  handle: string;
  store: ToastStore;
  onDone: () => void;
}

// Mounted each time the dialog opens (the overlay drops its content on close), so the values are
// read afresh every time.
function PropertiesBody({ rpc, handle, store, onDone }: BodyProps) {
  const [info, setInfo] = useState<DocInfo | null>(null);
  const [values, setValues] = useState<EditableValues | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<PropertiesTab>('description');
  const [fonts, setFonts] = useState<FontsState>({ kind: 'idle' });
  const [security, setSecurity] = useState<SecurityTabState>({ kind: 'idle' });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void loadProperties({ rpc, handle, store }).then((next) => {
      if (!live) return;
      if (next === undefined) setLoadFailed(true);
      else {
        setInfo(next);
        setValues(editableValues(next));
      }
    });
    return () => {
      live = false;
    };
  }, [rpc, handle, store]);

  // session.fonts walks every page, so it runs once, when the tab is first shown or retried.
  const loadFontsTab = (): void => {
    setFonts({ kind: 'loading' });
    void loadFonts(rpc, handle, store).then((next) => {
      if (mounted.current) setFonts(next);
    });
  };

  // session.security is read once, when the Security tab is first shown. It has no retry: a
  // failure is shown inline and reported as a toast.
  const loadSecurityTab = (): void => {
    setSecurity({ kind: 'loading' });
    void loadSecurity({ rpc, handle, store }).then((next) => {
      if (!mounted.current) return;
      setSecurity(next === undefined ? { kind: 'failed' } : { kind: 'ready', state: next });
    });
  };

  const setField = (field: EditableField, value: string): void => {
    setValues((previous) => (previous === null ? previous : { ...previous, [field]: value }));
  };

  const apply = async (): Promise<void> => {
    if (info === null || values === null || busy) return;
    const tooLong = overLongFields(values);
    if (tooLong.length > 0) {
      const fields = tooLong.map((field) => t(FIELD_LABEL[field])).join(', ');
      setMessage(t('properties.tooLong', { max: MAX_FIELD_LENGTH, fields }));
      return;
    }
    setMessage(null);
    setBusy(true);
    const outcome = await applyProperties({ rpc, handle, store }, info, values);
    if (outcome.status === 'applied' || outcome.status === 'unchanged') {
      onDone();
      return;
    }
    // A failed call has already shown its error toast; the dialog stays open for another try.
    setBusy(false);
  };

  if (loadFailed) {
    return (
      <p className="properties-message" role="alert">
        {t('properties.loadFailed')}
      </p>
    );
  }
  if (info === null || values === null) {
    return (
      <p className="properties-hint" role="status">
        {t('properties.loading')}
      </p>
    );
  }
  return (
    <div className="properties">
      <Tabs
        className="properties-tabs"
        selectedKey={tab}
        onSelectionChange={(key) => {
          const next = PROPERTIES_TABS.find((candidate) => candidate === key) ?? 'description';
          setTab(next);
          if (next === 'fonts' && fonts.kind === 'idle') loadFontsTab();
          if (next === 'security' && security.kind === 'idle') loadSecurityTab();
        }}
      >
        <TabList aria-label={t('properties.tabs.label')} className="properties-tablist">
          <Tab id="description" className="properties-tab">
            {t('properties.tab.description')}
          </Tab>
          <Tab id="advanced" className="properties-tab">
            {t('properties.tab.advanced')}
          </Tab>
          <Tab id="fonts" className="properties-tab">
            {fonts.kind === 'ready'
              ? t('properties.tab.fontsCount', { count: fonts.fonts.length })
              : t('properties.tab.fonts')}
          </Tab>
          <Tab id="security" className="properties-tab">
            {t('properties.tab.security')}
          </Tab>
        </TabList>
        <TabPanel id="description" className="properties-panel">
          <DescriptionPanel info={info} values={values} busy={busy} onField={setField} />
        </TabPanel>
        <TabPanel id="advanced" className="properties-panel">
          <AdvancedPanel info={info} />
        </TabPanel>
        <TabPanel id="fonts" className="properties-panel">
          <FontsPanel state={fonts} onRetry={loadFontsTab} />
        </TabPanel>
        <TabPanel id="security" className="properties-panel">
          <SecurityPanel state={security} />
        </TabPanel>
      </Tabs>
      {message === null ? null : (
        <p className="properties-message" role="alert">
          {message}
        </p>
      )}
      <div className="properties-actions">
        <Button className="properties-button" onPress={onDone}>
          {t('properties.cancel')}
        </Button>
        <Button
          className="properties-button properties-primary"
          isDisabled={busy}
          onPress={() => {
            void apply();
          }}
        >
          {t('properties.apply')}
        </Button>
      </div>
    </div>
  );
}
