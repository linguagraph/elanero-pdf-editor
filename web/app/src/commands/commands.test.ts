import { describe, expect, it, vi } from 'vitest';
import shortcutTable from '../../../src/generated/shortcuts.json';
import { EN, type MessageId } from '../i18n/en';
import { COMMANDS, DEFERRED_IDS, GROUPS, MENU, REGISTRY, WEB_ONLY_IDS } from './catalog';
import { MAX_ZOOM, MIN_ZOOM } from '../view/zoom';
import {
  type CommandState,
  type CommandDef,
  createRegistry,
  DISABLED_REASON_LABELS,
  isSharedId,
  TAB_LABELS,
  TAB_ORDER,
  type ViewCommandState,
} from './registry';
import { commandDisabledReason, menuSections, ribbonLayout, runCommand } from './run';
import { addTab, applyDocState, EMPTY_TABS } from '../tabs/tabState';
import { type CommentToolId, toggleCommentTool } from '../comments/tools';

const SHARED: Record<string, { keys: string[] }> = shortcutTable.commands;

function state(overrides: Partial<CommandState> = {}): CommandState {
  return {
    hasDocument: false,
    hasRecentFiles: false,
    canUndo: false,
    canRedo: false,
    capabilities: new Set(),
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
    ...overrides,
  };
}

const ALL_CAPABILITIES = new Set([
  'signing',
  'ocr',
  'office_import',
  'pdfa',
  'pwa_install',
] as const);

const withDoc = state({ hasDocument: true, capabilities: ALL_CAPABILITIES });

describe('registry declarations', () => {
  it('rejects a duplicate command id', () => {
    const def: CommandDef = {
      id: 'save',
      labelId: 'command.save.label',
      group: 'home.file',
      enabled: () => null,
    };
    expect(() => createRegistry([def, def], GROUPS, [])).toThrow(/duplicate command id: save/);
  });

  it('rejects a command in a group that does not exist', () => {
    const def: CommandDef = {
      id: 'save',
      labelId: 'command.save.label',
      group: 'nowhere',
      enabled: () => null,
    };
    expect(() => createRegistry([def], GROUPS, [])).toThrow(/unknown group/);
  });

  it('rejects a menu entry that names no command', () => {
    expect(() => createRegistry([], GROUPS, [['missing']])).toThrow(/no such command/);
  });

  it('rejects a command icon that is not in the bundled set', () => {
    const def = {
      id: 'save',
      labelId: 'command.save.label',
      group: 'home.file',
      enabled: () => null,
      icon: 'no-such-icon',
    } as unknown as CommandDef;
    expect(() => createRegistry([def], GROUPS, [])).toThrow(/unknown icon no-such-icon/);
  });

  it('gives each command its override icon, else the desktop icon from the shared table', () => {
    expect(REGISTRY.icon('whats-different')).toBe('info');
    expect(REGISTRY.icon('save')).toBe('save');
    expect(REGISTRY.icon('undo')).toBe('undo-2');
    expect(REGISTRY.icon('no-such-command')).toBeUndefined();
  });

  it('gives every search keyword an English string', () => {
    const withKeywords = COMMANDS.filter((def) => def.keywordsId !== undefined);
    expect(withKeywords.length).toBeGreaterThanOrEqual(10);
    for (const def of withKeywords) {
      const keywordsId = def.keywordsId as MessageId;
      expect(EN[keywordsId].trim(), def.id).not.toBe('');
    }
  });

  it('has no duplicate ids in the built-in catalogue', () => {
    const ids = COMMANDS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes every shortcut from the shared table, never from the declarations', () => {
    for (const def of REGISTRY.commands) {
      expect(Object.keys(def), def.id).not.toContain('shortcut');
      const expected = isSharedId(def.id) ? SHARED[def.id]?.keys[0] : undefined;
      expect(REGISTRY.defaultShortcut(def.id), def.id).toBe(expected);
    }
    expect(REGISTRY.defaultShortcut('save')).toBe('Ctrl+S');
    expect(REGISTRY.defaultShortcut('undo')).toBe('Ctrl+Z');
  });

  it('splits ids exactly into shared (in the table) and web-only', () => {
    for (const def of COMMANDS) {
      expect(isSharedId(def.id), def.id).toBe(!WEB_ONLY_IDS.has(def.id));
    }
    for (const id of WEB_ONLY_IDS) {
      expect(isSharedId(id), id).toBe(false);
    }
  });

  it('keeps the deferred ids out of the registry, the menu and the ribbon, though they are shared', () => {
    expect([...DEFERRED_IDS].sort()).toEqual([
      'rotate-view-clockwise',
      'rotate-view-counterclockwise',
    ]);
    const listed = REGISTRY.commands.map((def) => def.id);
    for (const id of DEFERRED_IDS) {
      expect(REGISTRY.get(id), id).toBeUndefined();
      expect(listed, id).not.toContain(id);
      expect(MENU.flat(), id).not.toContain(id);
      expect(isSharedId(id), id).toBe(true);
    }
  });

  it('shows only Night Mode in the Reading group on the web', () => {
    const reading = REGISTRY.commands
      .filter((def) => def.group === 'view.reading')
      .map((def) => def.id);
    expect(reading).toEqual(['night-reading']);
  });

  it('has an English label for every label id, group, tab and reason', () => {
    const ids: MessageId[] = [
      ...COMMANDS.map((def) => def.labelId),
      ...GROUPS.map((group) => group.labelId),
      ...TAB_ORDER.map((tab) => TAB_LABELS[tab]),
      ...Object.values(DISABLED_REASON_LABELS),
      'ribbon.label',
      'appMenu.label',
    ];
    for (const id of ids) {
      expect(EN[id], id).toBeTruthy();
    }
  });

  it('keeps the ribbon in the desktop order, Home first', () => {
    expect(TAB_ORDER).toEqual(['home', 'edit', 'organize', 'protect', 'comment', 'view', 'tools']);
  });
});

describe('document navigation commands (W4.3b S3)', () => {
  it('needs a document for Go to Page and for Next and Previous Document, like the others', () => {
    for (const id of ['go-to-page', 'next-document', 'previous-document']) {
      const handler = vi.fn();
      expect(runCommand(REGISTRY, id, state(), { [id]: handler }), id).toBe(false);
      expect(runCommand(REGISTRY, id, withDoc, { [id]: handler }), id).toBe(true);
      expect(handler, id).toHaveBeenCalledTimes(1);
    }
  });

  it('has no menu entry for Next and Previous Document (palette and keys only)', () => {
    const menu = MENU.flat();
    expect(menu).not.toContain('next-document');
    expect(menu).not.toContain('previous-document');
  });

  it('puts Go to Page on the Home ribbon, in the navigate group', () => {
    expect(REGISTRY.get('go-to-page')?.group).toBe('home.navigate');
  });
});

describe('open recent', () => {
  it('is disabled while the recent list is empty, and runs once there are files', () => {
    const openRecent = vi.fn();
    expect(runCommand(REGISTRY, 'open-recent', state(), { 'open-recent': openRecent })).toBe(false);
    const withRecent = state({ hasRecentFiles: true });
    expect(runCommand(REGISTRY, 'open-recent', withRecent, { 'open-recent': openRecent })).toBe(
      true,
    );
    expect(openRecent).toHaveBeenCalledTimes(1);
  });

  it('is not a desktop shortcut, so it is web-only', () => {
    expect(WEB_ONLY_IDS.has('open-recent')).toBe(true);
  });
});

describe('visibility and running', () => {
  it('does not run a disabled command, even when a handler exists', () => {
    const save = vi.fn();
    const ran = runCommand(REGISTRY, 'save', state(), { save });
    expect(ran).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('runs an enabled command once with its handler', () => {
    const save = vi.fn();
    expect(runCommand(REGISTRY, 'save', withDoc, { save })).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not run a command with no handler', () => {
    expect(runCommand(REGISTRY, 'save', withDoc, {})).toBe(false);
  });

  it('disables undo and redo by their own state', () => {
    const undo = vi.fn();
    expect(runCommand(REGISTRY, 'undo', withDoc, { undo })).toBe(false);
    expect(runCommand(REGISTRY, 'undo', { ...withDoc, canUndo: true }, { undo })).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('gives the disabled reason of undo and redo: no document, then nothing to step back', () => {
    const handlers = { undo: vi.fn(), redo: vi.fn() };
    const undo = REGISTRY.get('undo');
    const redo = REGISTRY.get('redo');
    if (undo === undefined || redo === undefined) throw new Error('undo and redo are declared');
    expect(commandDisabledReason(undo, state(), handlers)).toBe('needsDocument');
    expect(commandDisabledReason(redo, state(), handlers)).toBe('needsDocument');
    expect(commandDisabledReason(undo, withDoc, handlers)).toBe('nothingToUndo');
    expect(commandDisabledReason(redo, withDoc, handlers)).toBe('nothingToRedo');
    expect(commandDisabledReason(undo, { ...withDoc, canUndo: true }, handlers)).toBeNull();
    expect(commandDisabledReason(redo, { ...withDoc, canRedo: true }, handlers)).toBeNull();
  });

  it('follows the engine history: the tab flags from a state event decide undo', () => {
    let tabs = addTab(EMPTY_TABS, {
      name: 'a.pdf',
      handle: 'h1',
      pages: 1,
      encrypted: false,
      signed: false,
    });
    const undo = vi.fn();
    const enabled = (): boolean =>
      runCommand(
        REGISTRY,
        'undo',
        state({ hasDocument: true, canUndo: tabs.tabs[0]?.canUndo ?? false }),
        { undo },
      );
    expect(enabled()).toBe(false);
    // A change: the engine's state event says it can undo now.
    tabs = applyDocState(tabs, 'h1', { dirty: true, can_undo: true, can_redo: false, busy: '' });
    expect(enabled()).toBe(true);
    // The undo: the engine's state event says there is nothing left to undo.
    tabs = applyDocState(tabs, 'h1', {
      dirty: false,
      can_undo: false,
      can_redo: true,
      busy: '',
    });
    expect(enabled()).toBe(false);
    expect(tabs.tabs[0]?.canRedo).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('hides a command whose capability is missing, from the ribbon and the menu', () => {
    const without = state({ hasDocument: true });
    const tabs = ribbonLayout(REGISTRY, without);
    const groupIds = tabs.flatMap((tab) => tab.groups.map((group) => group.group.id));
    expect(groupIds).not.toContain('protect.sign');
    expect(groupIds).not.toContain('tools.ocr');
    const menu = menuSections(REGISTRY, without)
      .flat()
      .map((def) => def.id);
    expect(menu).not.toContain('install-app');
    expect(runCommand(REGISTRY, 'sign-document', without, { 'sign-document': vi.fn() })).toBe(
      false,
    );
  });

  it('drops a tab whose groups are all hidden', () => {
    const tabs = ribbonLayout(REGISTRY, state({ hasDocument: true }));
    expect(tabs.map((tab) => tab.tab)).toEqual(TAB_ORDER);
    const onlyPdfa = ribbonLayout(
      createRegistry(
        COMMANDS.filter((def) => def.group === 'tools.standards'),
        GROUPS,
        [],
      ),
      state(),
    );
    expect(onlyPdfa.map((tab) => tab.tab)).toEqual([]);
  });
});

describe('ribbon and menu layouts', () => {
  it('lists each tab group in declaration order with its visible commands', () => {
    const home = ribbonLayout(REGISTRY, withDoc).find((tab) => tab.tab === 'home');
    expect(home?.groups.map((group) => group.group.id)).toEqual([
      'home.file',
      'home.history',
      'home.tools',
      'home.search',
      'home.navigate',
    ]);
    expect(home?.groups[0]?.commands.map((def) => def.id)).toEqual([
      'open',
      'save',
      'print',
      'document-properties',
    ]);
  });

  it('keeps app-menu-only commands out of the ribbon', () => {
    const ribbonIds = ribbonLayout(REGISTRY, withDoc).flatMap((tab) =>
      tab.groups.flatMap((group) => group.commands.map((def) => def.id)),
    );
    for (const id of ['preferences', 'keyboard-shortcuts', 'about-elanero', 'close']) {
      expect(ribbonIds).not.toContain(id);
    }
  });

  it('builds the app menu sections in W1.6 order', () => {
    const sections = menuSections(REGISTRY, withDoc).map((section) => section.map((def) => def.id));
    expect(sections[0]).toEqual([
      'open',
      'open-recent',
      'save',
      'save-as',
      'print',
      'document-properties',
      'close',
    ]);
    expect(sections[1]).toEqual(['preferences', 'keyboard-shortcuts']);
    expect(sections[2]).toEqual(['help', 'whats-different', 'install-app', 'about-elanero']);
    // With every capability on, each declared menu entry shows.
    expect(sections.flat().length).toBe(MENU.flat().length);
  });
});

describe('the Select and Hand tools (W4.10)', () => {
  it('shows Select as pressed by default and Hand as not pressed', () => {
    const select = REGISTRY.get('select-tool');
    const hand = REGISTRY.get('hand-tool');
    expect(select?.checked?.(withDoc)).toBe(true);
    expect(hand?.checked?.(withDoc)).toBe(false);
  });

  it('shows Hand as pressed while the view tool is Hand', () => {
    const handOn = state({ hasDocument: true, capabilities: ALL_CAPABILITIES, viewTool: 'hand' });
    expect(REGISTRY.get('hand-tool')?.checked?.(handOn)).toBe(true);
    expect(REGISTRY.get('select-tool')?.checked?.(handOn)).toBe(false);
  });

  it('enables both only with a document open', () => {
    expect(commandDisabledReasonOf('select-tool', withDoc)).toBeNull();
    expect(commandDisabledReasonOf('hand-tool', withDoc)).toBeNull();
    expect(commandDisabledReasonOf('hand-tool', state())).toBe('needsDocument');
  });

  it('runs the handler through the registry, and not without one', () => {
    const hand = vi.fn();
    expect(runCommand(REGISTRY, 'hand-tool', withDoc, { 'hand-tool': hand })).toBe(true);
    expect(hand).toHaveBeenCalledTimes(1);
    expect(runCommand(REGISTRY, 'hand-tool', state(), { 'hand-tool': hand })).toBe(false);
    expect(hand).toHaveBeenCalledTimes(1);
  });
});

describe('the shape tools (W6.7b)', () => {
  const SHAPES = ['add-rectangle', 'add-ellipse', 'add-line'] as const;
  const editable = state({ hasDocument: true, capabilities: ALL_CAPABILITIES, contentEdit: true });

  it('need a document whose engine can edit content, with the reason', () => {
    for (const id of SHAPES) {
      expect(commandDisabledReasonOf(id, state())).toBe('needsDocument');
      expect(commandDisabledReasonOf(id, withDoc)).toBe('contentEditOff');
      expect(commandDisabledReasonOf(id, editable)).toBeNull();
    }
  });

  it('show only their own tool as pressed', () => {
    const rectangle = state({ ...editable, viewTool: 'shape-rectangle' });
    expect(REGISTRY.get('add-rectangle')?.checked?.(rectangle)).toBe(true);
    expect(REGISTRY.get('add-ellipse')?.checked?.(rectangle)).toBe(false);
    expect(REGISTRY.get('add-line')?.checked?.(rectangle)).toBe(false);
    expect(REGISTRY.get('select-tool')?.checked?.(rectangle)).toBe(false);
  });

  it('run their handler through the registry', () => {
    const rectangle = vi.fn();
    expect(runCommand(REGISTRY, 'add-rectangle', editable, { 'add-rectangle': rectangle })).toBe(
      true,
    );
    expect(rectangle).toHaveBeenCalledTimes(1);
  });
});

describe('the Replace and Export commands (W6.7b slice 2b)', () => {
  const editable = state({ hasDocument: true, capabilities: ALL_CAPABILITIES, contentEdit: true });
  const oneImage = { ...editable, singleImageSelected: true };

  it('Replace needs the content edit and exactly one picture selected', () => {
    expect(commandDisabledReasonOf('replace-image', state())).toBe('needsDocument');
    expect(commandDisabledReasonOf('replace-image', withDoc)).toBe('contentEditOff');
    expect(commandDisabledReasonOf('replace-image', editable)).toBe('selectOneImage');
    expect(commandDisabledReasonOf('replace-image', oneImage)).toBeNull();
  });

  it('Export needs exactly one picture selected, and is named Export Image', () => {
    expect(commandDisabledReasonOf('extract-image', withDoc)).toBe('selectOneImage');
    expect(commandDisabledReasonOf('extract-image', oneImage)).toBeNull();
    expect(EN['command.extract-image.label']).toBe('Export Image');
    expect(EN[DISABLED_REASON_LABELS.selectOneImage]).toMatch(/Select one picture/);
  });
});

describe('the Delete comment command (issue 732)', () => {
  const withDocument = state({ hasDocument: true });
  const oneComment = { ...withDocument, commentsSelected: true };

  it('needs a document, then a selected comment', () => {
    expect(commandDisabledReasonOf('delete-comment', state())).toBe('needsDocument');
    expect(commandDisabledReasonOf('delete-comment', withDocument)).toBe('selectComment');
    expect(commandDisabledReasonOf('delete-comment', oneComment)).toBeNull();
  });

  it('has a handler, and its reason says what to do in words', () => {
    const handler = vi.fn();
    expect(runCommand(REGISTRY, 'delete-comment', oneComment, { 'delete-comment': handler })).toBe(
      true,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(EN[DISABLED_REASON_LABELS.selectComment]).toMatch(/Select/);
  });
});

describe('the Add Image command (W6.7b slice 2a)', () => {
  const editable = state({ hasDocument: true, capabilities: ALL_CAPABILITIES, contentEdit: true });

  it('needs a document whose engine can edit content, with the reason', () => {
    expect(commandDisabledReasonOf('add-image', state())).toBe('needsDocument');
    expect(commandDisabledReasonOf('add-image', withDoc)).toBe('contentEditOff');
    expect(commandDisabledReasonOf('add-image', editable)).toBeNull();
  });

  it('is shown as pressed only while the Image tool is on', () => {
    expect(REGISTRY.get('add-image')?.checked?.(state({ ...editable, viewTool: 'image' }))).toBe(
      true,
    );
    expect(REGISTRY.get('add-image')?.checked?.(editable)).toBe(false);
  });

  it('runs its handler through the registry', () => {
    const addImage = vi.fn();
    expect(runCommand(REGISTRY, 'add-image', editable, { 'add-image': addImage })).toBe(true);
    expect(addImage).toHaveBeenCalledTimes(1);
  });
});

describe('the comment and redaction tools (W4.3a S7)', () => {
  it('shows each comment tool as pressed only while it is the tool on', () => {
    const on = state({ hasDocument: true, commentTool: 'rectangle' });
    expect(REGISTRY.get('rectangle')?.checked?.(on)).toBe(true);
    expect(REGISTRY.get('sticky-note')?.checked?.(on)).toBe(false);
    expect(REGISTRY.get('highlight')?.checked?.(on)).toBe(false);
  });

  it('shows Attach File as pressed only while the attach tool is on', () => {
    expect(REGISTRY.get('attach-file')?.checked?.(state({ commentTool: 'attach' }))).toBe(true);
    expect(REGISTRY.get('attach-file')?.checked?.(state({ commentTool: 'note' }))).toBe(false);
  });

  it('shows Redact as pressed while the mark tool is on', () => {
    expect(REGISTRY.get('redact')?.checked?.(state({ redacting: true }))).toBe(true);
    expect(REGISTRY.get('redact')?.checked?.(state())).toBe(false);
  });

  it('needs a document for the comment and redact commands, with that reason', () => {
    for (const id of ['sticky-note', 'highlight', 'rectangle', 'redact']) {
      expect(commandDisabledReasonOf(id, state())).toBe('needsDocument');
      expect(commandDisabledReasonOf(id, withDoc)).toBeNull();
    }
  });

  it('enables Apply Redactions only with marks to apply, and says why not otherwise', () => {
    expect(commandDisabledReasonOf('apply-redactions', state())).toBe('needsDocument');
    expect(commandDisabledReasonOf('apply-redactions', withDoc)).toBe('noRedactionMarks');
    const ready = state({ hasDocument: true, canApplyRedactions: true });
    expect(commandDisabledReasonOf('apply-redactions', ready)).toBeNull();
  });

  it('says an apply in progress is the reason while it runs, not that there are no marks', () => {
    // A running apply has marks on the list but no longer offers them.
    const busy = state({ hasDocument: true, canApplyRedactions: false, redactionBusy: true });
    expect(commandDisabledReasonOf('apply-redactions', busy)).toBe('redactionBusy');
    expect(DISABLED_REASON_LABELS.redactionBusy).toBe('disabled.redactionBusy');
  });

  it('clears the marks under the same rules as Apply, and not while an apply runs', () => {
    expect(commandDisabledReasonOf('clear-redaction-marks', state())).toBe('needsDocument');
    expect(commandDisabledReasonOf('clear-redaction-marks', withDoc)).toBe('noRedactionMarks');
    const ready = state({ hasDocument: true, canApplyRedactions: true });
    expect(commandDisabledReasonOf('clear-redaction-marks', ready)).toBeNull();
    const busy = state({ hasDocument: true, canApplyRedactions: false, redactionBusy: true });
    expect(commandDisabledReasonOf('clear-redaction-marks', busy)).toBe('redactionBusy');
    // The command sits in the Protect group with Apply, and is web-only (no desktop id).
    expect(REGISTRY.get('clear-redaction-marks')?.group).toBe('protect.redact');
    expect(WEB_ONLY_IDS.has('clear-redaction-marks')).toBe(true);
  });

  it('disables the Edit tool commands without the content_edit capability, with the reason', () => {
    // The engine's content_edit flag (W6.7a): without it the commands say why, and never run.
    const edit = ['edit-text-images', 'delete-selected-objects'];
    const off = state({ hasDocument: true, contentEdit: false });
    const on = state({ hasDocument: true, contentEdit: true });
    for (const id of edit) {
      expect(commandDisabledReasonOf(id, state())).toBe('needsDocument');
      expect(commandDisabledReasonOf(id, off)).toBe('contentEditOff');
      expect(commandDisabledReasonOf(id, on)).toBeNull();
      expect(DISABLED_REASON_LABELS.contentEditOff).toBe('disabled.contentEditOff');
    }
    // The reason is a message the app shows: it resolves to the English text, not a bare key.
    expect(EN[DISABLED_REASON_LABELS.contentEditOff]).toMatch(/cannot be edited/);
    const handler = vi.fn();
    expect(runCommand(REGISTRY, 'edit-text-images', off, { 'edit-text-images': handler })).toBe(
      false,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(runCommand(REGISTRY, 'edit-text-images', on, { 'edit-text-images': handler })).toBe(
      true,
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it('runs Redact through its handler, and not without a document', () => {
    const redact = vi.fn();
    expect(runCommand(REGISTRY, 'redact', withDoc, { redact })).toBe(true);
    expect(runCommand(REGISTRY, 'redact', state(), { redact })).toBe(false);
    expect(redact).toHaveBeenCalledTimes(1);
  });
});

// The view state of an open document on the given page, at 100 % in the continuous layout.
function viewOf(overrides: Partial<ViewCommandState> = {}): ViewCommandState {
  return {
    page: 2,
    pageCount: 3,
    zoom: 1,
    fit: null,
    layout: 'continuous',
    firstAlone: false,
    night: false,
    ...overrides,
  };
}

describe('the View and Home commands (W4.3a S6)', () => {
  const inView = state({ hasDocument: true, view: viewOf(), capabilities: ALL_CAPABILITIES });

  it('enables Back and Forward only when the history has an entry that way', () => {
    expect(commandDisabledReasonOf('back', inView)).toBe('cannotGoBack');
    expect(commandDisabledReasonOf('forward', inView)).toBe('cannotGoForward');
    const moved = { ...inView, canGoBack: true, canGoForward: true };
    expect(commandDisabledReasonOf('back', moved)).toBeNull();
    expect(commandDisabledReasonOf('forward', moved)).toBeNull();
  });

  it('disables Previous Page on the first page and Next Page on the last, with reasons', () => {
    const first = { ...inView, view: viewOf({ page: 1 }) };
    const last = { ...inView, view: viewOf({ page: 3 }) };
    expect(commandDisabledReasonOf('previous-page', first)).toBe('firstPage');
    expect(commandDisabledReasonOf('next-page', first)).toBeNull();
    expect(commandDisabledReasonOf('next-page', last)).toBe('lastPage');
    expect(commandDisabledReasonOf('previous-page', last)).toBeNull();
    expect(commandDisabledReasonOf('next-page', inView)).toBeNull();
  });

  it('says not available yet, not last or first page, before the view reports its page count', () => {
    // The view's first state has page 1 and no pages: Next Page must not claim it is the last page.
    const unknown = { ...inView, view: viewOf({ page: 1, pageCount: 0 }) };
    expect(commandDisabledReasonOf('next-page', unknown)).toBe('notAvailableYet');
    expect(commandDisabledReasonOf('previous-page', unknown)).toBe('notAvailableYet');
  });

  it('needs a document for the page commands and the zoom commands', () => {
    for (const id of ['previous-page', 'next-page', 'zoom-in', 'zoom-out']) {
      expect(commandDisabledReasonOf(id, state())).toBe('needsDocument');
    }
  });

  it('disables Zoom In at the largest zoom and Zoom Out at the smallest', () => {
    expect(
      commandDisabledReasonOf('zoom-in', { ...inView, view: viewOf({ zoom: MAX_ZOOM }) }),
    ).toBe('maxZoom');
    expect(
      commandDisabledReasonOf('zoom-out', { ...inView, view: viewOf({ zoom: MIN_ZOOM }) }),
    ).toBe('minZoom');
    expect(commandDisabledReasonOf('zoom-in', inView)).toBeNull();
    expect(commandDisabledReasonOf('zoom-out', inView)).toBeNull();
  });

  it('shows the page layout the view is in as pressed, and Night Mode while night reading', () => {
    const checkedOf = (id: string, current: CommandState) => REGISTRY.get(id)?.checked?.(current);
    const twoCover = { ...inView, view: viewOf({ layout: 'twoPage', firstAlone: true }) };
    const twoPlain = { ...inView, view: viewOf({ layout: 'twoPage' }) };
    expect(checkedOf('single-page-continuous', inView)).toBe(true);
    expect(checkedOf('two-up-continuous', inView)).toBe(false);
    expect(checkedOf('two-up-continuous', twoPlain)).toBe(true);
    expect(checkedOf('two-up-with-cover-page', twoPlain)).toBe(false);
    expect(checkedOf('two-up-with-cover-page', twoCover)).toBe(true);
    // Single Page is the layout that shows one page at a time (it had no pressed state before).
    expect(checkedOf('single-page', inView)).toBe(false);
    expect(checkedOf('single-page', { ...inView, view: viewOf({ layout: 'single' }) })).toBe(true);
    // A cover flag left over from a two-page layout does not press Single Page when continuous.
    expect(
      checkedOf('single-page-continuous', { ...inView, view: viewOf({ firstAlone: true }) }),
    ).toBe(true);
    expect(checkedOf('night-reading', inView)).toBe(false);
    expect(checkedOf('night-reading', { ...inView, view: viewOf({ night: true }) })).toBe(true);
  });

  it('runs the layout and night handlers, and not when the document is closed', () => {
    const night = vi.fn();
    expect(runCommand(REGISTRY, 'night-reading', inView, { 'night-reading': night })).toBe(true);
    expect(night).toHaveBeenCalledTimes(1);
    expect(runCommand(REGISTRY, 'night-reading', state(), { 'night-reading': night })).toBe(false);
    expect(night).toHaveBeenCalledTimes(1);
  });
});

function commandDisabledReasonOf(id: string, current: CommandState): string | null {
  const def = REGISTRY.get(id);
  return def === undefined ? 'missing' : def.enabled(current);
}

describe('the stamp command', () => {
  it('is checked while the stamp tool is on', () => {
    expect(REGISTRY.get('stamp')?.checked?.(state({ commentTool: 'stamp' }))).toBe(true);
    expect(REGISTRY.get('stamp')?.checked?.(state({ commentTool: 'note' }))).toBe(false);
  });

  it('turns the stamp tool on, or off when it is already on', () => {
    const set = vi.fn();
    const run = (current: CommentToolId | null) =>
      runCommand(REGISTRY, 'stamp', state({ hasDocument: true, commentTool: current }), {
        stamp: () => toggleCommentTool(current, 'stamp', set),
      });
    expect(run(null)).toBe(true);
    expect(set).toHaveBeenLastCalledWith('stamp');
    expect(run('stamp')).toBe(true);
    expect(set).toHaveBeenLastCalledWith(null);
  });
});

describe('the Space Usage command (issue 737)', () => {
  it('needs a document, and runs its handler when there is one', () => {
    expect(commandDisabledReasonOf('space-usage', state())).toBe('needsDocument');
    expect(commandDisabledReasonOf('space-usage', state({ hasDocument: true }))).toBeNull();
    const handler = vi.fn();
    expect(
      runCommand(REGISTRY, 'space-usage', state({ hasDocument: true }), { 'space-usage': handler }),
    ).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
