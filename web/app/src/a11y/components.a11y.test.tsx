import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { CommentsExportDialog } from '../commentsExport/CommentsExportDialog';
import { CommentsImportDialog } from '../commentsImport/CommentsImportDialog';
import { ExportDialog } from '../export/ExportDialog';
import { FlattenDialog } from '../flatten/FlattenDialog';
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
  const { blocking } = await runAxe(context);
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
      await expectAccessible(host);
    }
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
});
