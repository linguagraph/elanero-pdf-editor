import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY } from '../commands/catalog';
import { type CommandState } from '../commands/registry';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { StartPage } from '../start/StartPage';
import { Ribbon } from '../ribbon/Ribbon';
import { CommandPalette } from '../palette/CommandPalette';
import { openCommandPalette } from '../palette/openCommandPalette';
import { ShortcutsDialog } from '../palette/ShortcutsDialog';
import { SaveAsDialog } from '../save/SaveAsDialog';
import { PrintDialog } from '../print/PrintDialog';
import { PreferencesDialog } from '../prefs/PreferencesDialog';
import { CombineDialog } from '../combine/CombineDialog';
import { CompressDialog } from '../compress/CompressDialog';
import { SpaceAuditTable } from '../compress/SpaceAuditTable';
import { CommentsExportDialog } from '../commentsExport/CommentsExportDialog';
import { CommentsImportDialog } from '../commentsImport/CommentsImportDialog';
import { LinkConfirmDialog } from '../links/LinkConfirmDialog';
import { LinkCache, type LinksRpc } from '../links/linkCache';
import { PageLinkLayer } from '../links/PageLinkLayer';
import type { LinksResult } from '../rpc/generated';
import { ExportDialog } from '../export/ExportDialog';
import { FlattenDialog } from '../flatten/FlattenDialog';
import { DocumentTabs } from '../tabs/DocumentTabs';
import { activateTab, addTab, EMPTY_TABS } from '../tabs/tabState';
import { runAxe } from '../test/axe';

// Component axe checks (W8.5 S1). Each test renders one screen and fails on a serious or critical
// violation. The screens render into jsdom, so colour contrast and target size are checked later.
// Dialogs render through a portal into document.body, so their checks run on the whole body.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a popover or modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => '\\' + c) },
  });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
});

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

const state: CommandState = {
  hasDocument: true,
  hasRecentFiles: false,
  canUndo: false,
  canRedo: false,
  capabilities: new Set(['signing', 'ocr', 'office_import', 'pdfa', 'pwa_install']),
  contentEdit: false,
  ribbonCompact: false,
  ribbonCollapsed: false,
  viewTool: 'select',
  commentTool: null,
  redacting: false,
  canApplyRedactions: false,
  canGoBack: false,
  canGoForward: false,
  view: null,
};

// A check over the body must find something open to check: a portalled dialog or the palette.
// Otherwise an empty body would pass for free.
async function expectAccessible(context?: Element): Promise<void> {
  if (context === undefined) {
    expect(document.querySelector('[role="dialog"]'), 'an open dialog').not.toBeNull();
  }
  // Moderate and minor findings are advisories: printed for the run's report, never failing it.
  const { blocking, advisory } = await runAxe(context);
  for (const line of advisory) console.info(`axe advisory ${line}`);
  expect(blocking).toEqual([]);
}

describe('component axe checks (W8.5 S1)', () => {
  it('start page', async () => {
    render(
      <StartPage
        recent={[]}
        pickHint={null}
        onOpen={() => undefined}
        onRecent={() => undefined}
        onFiles={() => undefined}
        onAbout={() => undefined}
      />,
    );
    await expectAccessible(host);
  });

  it('ribbon, with a document open', async () => {
    render(<Ribbon registry={REGISTRY} state={state} handlers={{}} />);
    await expectAccessible(host);
  });

  it('ribbon, with no document open', async () => {
    render(<Ribbon registry={REGISTRY} state={{ ...state, hasDocument: false }} handlers={{}} />);
    await expectAccessible(host);
  });

  it('ribbon, each of its tabs', async () => {
    render(<Ribbon registry={REGISTRY} state={state} handlers={{}} />);
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.length).toBeGreaterThan(1);
    for (const tab of tabs) {
      act(() => {
        tab.click();
      });
      // react-aria sets aria-selected on the tab it shows, so a click must move it here.
      expect(tab.getAttribute('aria-selected')).toBe('true');
      await expectAccessible(host);
    }
  });

  it('document tab strip', async () => {
    let tabs = addTab(EMPTY_TABS, { name: 'a.pdf', handle: 'a', pages: 1 });
    tabs = addTab(tabs, { name: 'b.pdf', handle: 'b', pages: 1 });
    render(
      <DocumentTabs
        state={activateTab(tabs, 2)}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );
    await expectAccessible(host);
  });

  it('command palette, open', async () => {
    render(<CommandPalette registry={REGISTRY} state={state} handlers={{}} />);
    act(() => {
      openCommandPalette();
    });
    await expectAccessible();
  });

  it('keyboard shortcuts dialog', async () => {
    render(<ShortcutsDialog isOpen onClose={() => undefined} registry={REGISTRY} state={state} />);
    await expectAccessible();
  });

  it('save as dialog', async () => {
    render(
      <SaveAsDialog
        tab={{ name: 'report.pdf', signed: false, encrypted: false }}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await expectAccessible();
  });

  it('print dialog, with no document', async () => {
    render(
      <PrintDialog
        isOpen
        onClose={() => undefined}
        session={null}
        pageCount={0}
        currentPage={1}
        startWorker={undefined}
      />,
    );
    await expectAccessible();
  });

  it('preferences dialog', async () => {
    render(<PreferencesDialog isOpen onClose={() => undefined} hasDocuments={false} />);
    await expectAccessible();
  });

  it('combine dialog', async () => {
    const store = createJobProgressStore({ toasts: createToastStore() });
    render(<CombineDialog isOpen onClose={() => undefined} store={store} />);
    await expectAccessible();
  });
});

// The dialogs below open with an engine they call only when the user acts, so a stub stands in.
const engine = {} as never;

describe('dialogs that open on an engine session (W8.5 S1)', () => {
  it('export dialog', async () => {
    render(
      <ExportDialog
        isOpen
        onClose={() => undefined}
        engine={engine}
        handle="h1"
        pageCount={3}
        currentPage={1}
        startWorker={() => ({}) as never}
      />,
    );
    await expectAccessible();
  });

  it('compress dialog', async () => {
    render(
      <CompressDialog
        isOpen
        onClose={() => undefined}
        engine={engine}
        handle="h1"
        startWorker={() => ({}) as never}
      />,
    );
    await expectAccessible();
  });

  it('space audit table in the compress result', async () => {
    render(
      <SpaceAuditTable
        settings="Balanced (ebook)"
        rows={[
          { key: 'images', before: 1048576, after: 204800 },
          { key: 'page_content', before: 122880, after: 122880 },
          { key: 'file_overhead', before: 2048, after: 1024 },
        ]}
      />,
    );
    await expectAccessible(document.body);
  });

  it('flatten dialog', async () => {
    render(
      <FlattenDialog
        isOpen
        onClose={() => undefined}
        engine={engine}
        handle="h1"
        startWorker={() => ({}) as never}
      />,
    );
    await expectAccessible();
  });

  it('comments export dialog', async () => {
    render(
      <CommentsExportDialog
        isOpen
        onClose={() => undefined}
        engine={engine}
        handle="h1"
        name="report.pdf"
        startWorker={() => ({}) as never}
      />,
    );
    await expectAccessible();
  });

  it('comments import dialog', async () => {
    render(<CommentsImportDialog isOpen onClose={() => undefined} engine={engine} handle="h1" />);
    await expectAccessible();
  });

  it('page link layer (W5.3)', async () => {
    // One link of each kind the layer names: a page, a web link, a mail link, a malformed address,
    // a link with no destination and a refused one.
    const rect = (y: number) => ({ x0: 72, y0: y, x1: 150, y1: y + 14 });
    const result: LinksResult = {
      revision: 1,
      truncated: false,
      links: [
        { rect: rect(100), kind: 'goto', page: 1, top: null, uri: '' },
        { rect: rect(120), kind: 'uri', page: null, top: null, uri: 'https://example.org/' },
        { rect: rect(140), kind: 'uri', page: null, top: null, uri: 'mailto:a@example.org' },
        { rect: rect(160), kind: 'uri', page: null, top: null, uri: 'https://' },
        { rect: rect(180), kind: 'goto', page: null, top: null, uri: '' },
        { rect: rect(200), kind: 'uri', page: null, top: null, uri: 'javascript:alert(1)' },
      ],
    };
    const rpc: LinksRpc = {
      call: vi.fn(() => Promise.resolve(result)) as unknown as LinksRpc['call'],
    };
    render(
      <PageLinkLayer
        cache={new LinkCache(rpc, 'h')}
        page={0}
        revision={1}
        zoom={1}
        labels={[]}
        onFollow={() => undefined}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The layer must have placed the links, or an empty layer would pass for free.
    expect(host.querySelectorAll('[role="link"]')).toHaveLength(6);
    await expectAccessible(host);
  });

  it('link confirm dialog (W5.3)', async () => {
    render(
      <LinkConfirmDialog
        target={{
          action: 'confirm',
          href: 'https://example.org/',
          scheme: 'https:',
          host: 'example.org',
        }}
        onClose={() => undefined}
      />,
    );
    await expectAccessible();
  });
});
