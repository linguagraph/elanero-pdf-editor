// The web app's commands, groups and app menu (W1.6 sections 2 and 6). Ids are the desktop's
// action ids, so the shared shortcut table applies to them. WEB_ONLY_IDS lists the commands the
// desktop does not have; the test checks that every other id is in the shared table. Keep this
// file to declarations: enabled rules and labels only, no PDF logic and no RPC.
import type { MessageId } from '../i18n/en';
import type { IconName } from '../theme/icons.generated';
import {
  ALWAYS,
  CAN_REDO,
  CAN_UNDO,
  createRegistry,
  CAN_APPLY_REDACTIONS,
  HAS_RECENT,
  NEEDS_DOCUMENT,
  type CommandDef,
  type Enabled,
  type GroupDef,
  type Registry,
} from './registry';

// Commands that web-only (the desktop has no such id). Everything else must be in the table.
export const WEB_ONLY_IDS: ReadonlySet<string> = new Set([
  'extract-image',
  'mark-text',
  'whats-different',
  'install-app',
  'open-recent',
  // The Comments panel's exports are not in the shared table yet; W7.1b adds the panel entry points.
  'export-comments',
  'import-comments',
]);

// Desktop commands the web does not offer (W4.3b): New Window and Exit have no meaning in a browser
// tab. They stay in the shared table, so the desktop keeps them, but they are not registry
// commands, so they have no ribbon, menu, palette or shortcut entry. A test checks this.
export const DROPPED_IDS: ReadonlySet<string> = new Set(['new-window', 'exit']);

export const GROUPS: readonly GroupDef[] = [
  { id: 'home.file', tab: 'home', labelId: 'ribbon.group.home.file' },
  { id: 'home.history', tab: 'home', labelId: 'ribbon.group.home.history' },
  { id: 'home.tools', tab: 'home', labelId: 'ribbon.group.home.tools' },
  { id: 'home.search', tab: 'home', labelId: 'ribbon.group.home.search' },
  { id: 'home.navigate', tab: 'home', labelId: 'ribbon.group.home.navigate' },
  { id: 'edit.edit', tab: 'edit', labelId: 'ribbon.group.edit.edit' },
  { id: 'edit.add', tab: 'edit', labelId: 'ribbon.group.edit.add' },
  { id: 'edit.shapes', tab: 'edit', labelId: 'ribbon.group.edit.shapes' },
  { id: 'edit.objects', tab: 'edit', labelId: 'ribbon.group.edit.objects' },
  { id: 'organize.organize', tab: 'organize', labelId: 'ribbon.group.organize.organize' },
  { id: 'organize.pages', tab: 'organize', labelId: 'ribbon.group.organize.pages' },
  { id: 'organize.assemble', tab: 'organize', labelId: 'ribbon.group.organize.assemble' },
  { id: 'organize.setup', tab: 'organize', labelId: 'ribbon.group.organize.setup' },
  { id: 'organize.marks', tab: 'organize', labelId: 'ribbon.group.organize.marks' },
  { id: 'protect.redact', tab: 'protect', labelId: 'ribbon.group.protect.redact' },
  { id: 'protect.cleanup', tab: 'protect', labelId: 'ribbon.group.protect.cleanup' },
  { id: 'protect.security', tab: 'protect', labelId: 'ribbon.group.protect.security' },
  { id: 'protect.sign', tab: 'protect', labelId: 'ribbon.group.protect.sign' },
  { id: 'comment.markup', tab: 'comment', labelId: 'ribbon.group.comment.markup' },
  { id: 'comment.comments', tab: 'comment', labelId: 'ribbon.group.comment.comments' },
  { id: 'comment.drawing', tab: 'comment', labelId: 'ribbon.group.comment.drawing' },
  { id: 'comment.manage', tab: 'comment', labelId: 'ribbon.group.comment.manage' },
  { id: 'view.zoom', tab: 'view', labelId: 'ribbon.group.view.zoom' },
  { id: 'view.display', tab: 'view', labelId: 'ribbon.group.view.display' },
  { id: 'view.reading', tab: 'view', labelId: 'ribbon.group.view.reading' },
  { id: 'tools.ocr', tab: 'tools', labelId: 'ribbon.group.tools.ocr' },
  { id: 'tools.export', tab: 'tools', labelId: 'ribbon.group.tools.export' },
  { id: 'tools.create', tab: 'tools', labelId: 'ribbon.group.tools.create' },
  { id: 'tools.optimize', tab: 'tools', labelId: 'ribbon.group.tools.optimize' },
  { id: 'tools.compare', tab: 'tools', labelId: 'ribbon.group.tools.compare' },
  { id: 'tools.standards', tab: 'tools', labelId: 'ribbon.group.tools.standards' },
  // App-menu-only groups: no ribbon tab.
  { id: 'app.file', tab: null, labelId: 'ribbon.group.app.file' },
  { id: 'app.settings', tab: null, labelId: 'ribbon.group.app.settings' },
  { id: 'app.help', tab: null, labelId: 'ribbon.group.app.help' },
  { id: 'app.ribbon', tab: null, labelId: 'ribbon.group.app.ribbon' },
];

// Adds search aliases to a declared command (W4.3b D3). A keyword only widens what the palette
// finds; the desktop has none.
function aliased(def: CommandDef, keywordsId: MessageId): CommandDef {
  return { ...def, keywordsId };
}

// A command with no document needed (or its own rule) takes the enabled rule as `enabled`.
function cmd(
  id: string,
  labelId: MessageId,
  group: string,
  enabled: Enabled = NEEDS_DOCUMENT,
  capability?: CommandDef['capability'],
): CommandDef {
  return capability === undefined
    ? { id, labelId, group, enabled }
    : { id, labelId, group, enabled, capability };
}

// Commands that work with no document open.
const OPEN_ANYTIME = ALWAYS;

// Icons for the commands the shared table gives no icon: the web-only ids and the desktop commands
// with none. Each name is checked against the bundled set when the registry is built.
const ICON_OVERRIDES: Readonly<Record<string, IconName>> = {
  'about-elanero': 'info',
  'compact-ribbon': 'panel-top',
  help: 'circle-help',
  'keyboard-shortcuts': 'list-checks',
  preferences: 'settings-2',
  'save-as': 'save',
  'extract-image': 'image-down',
  'mark-text': 'text-search',
  'whats-different': 'info',
  'install-app': 'upload',
  'open-recent': 'folder-open',
  'export-comments': 'file-output',
  'import-comments': 'file-input',
  'go-to-page': 'text-cursor-input',
};

const DECLARED_COMMANDS: readonly CommandDef[] = [
  // Home
  cmd('open', 'command.open.label', 'home.file', OPEN_ANYTIME),
  cmd('save', 'command.save.label', 'home.file'),
  cmd('print', 'command.print.label', 'home.file'),
  aliased(
    cmd('document-properties', 'command.document-properties.label', 'home.file'),
    'command.document-properties.keywords',
  ),
  cmd('undo', 'command.undo.label', 'home.history', CAN_UNDO),
  cmd('redo', 'command.redo.label', 'home.history', CAN_REDO),
  {
    ...cmd('select-tool', 'command.select-tool.label', 'home.tools'),
    checked: (state) => state.viewTool === 'select',
  },
  {
    ...cmd('hand-tool', 'command.hand-tool.label', 'home.tools'),
    checked: (state) => state.viewTool === 'hand',
  },
  aliased(cmd('find', 'command.find.label', 'home.search'), 'command.find.keywords'),
  cmd('back', 'command.back.label', 'home.navigate'),
  cmd('forward', 'command.forward.label', 'home.navigate'),
  cmd('previous-page', 'command.previous-page.label', 'home.navigate'),
  cmd('next-page', 'command.next-page.label', 'home.navigate'),
  // Alt+G (web override, W4.3b): focuses the status bar's page field.
  cmd('go-to-page', 'command.go-to-page.label', 'home.navigate'),

  // Edit
  cmd('edit-text-images', 'command.edit-text-images.label', 'edit.edit'),
  cmd('add-text', 'command.add-text.label', 'edit.add'),
  cmd('add-image', 'command.add-image.label', 'edit.add'),
  cmd('add-rectangle', 'command.add-rectangle.label', 'edit.shapes'),
  cmd('add-ellipse', 'command.add-ellipse.label', 'edit.shapes'),
  cmd('add-line', 'command.add-line.label', 'edit.shapes'),
  cmd('replace-image', 'command.replace-image.label', 'edit.objects'),
  cmd('extract-image', 'command.extract-image.label', 'edit.objects'),
  cmd('delete-selected-objects', 'command.delete-selected-objects.label', 'edit.objects'),

  // Organize
  cmd('organize-pages', 'command.organize-pages.label', 'organize.organize'),
  cmd('insert-pages', 'command.insert-pages.label', 'organize.pages'),
  aliased(
    cmd('delete-pages', 'command.delete-pages.label', 'organize.pages'),
    'command.delete-pages.keywords',
  ),
  cmd('duplicate-pages', 'command.duplicate-pages.label', 'organize.pages'),
  cmd('rotate-pages-left', 'command.rotate-pages-left.label', 'organize.pages'),
  cmd('rotate-pages-right', 'command.rotate-pages-right.label', 'organize.pages'),
  cmd('extract-pages', 'command.extract-pages.label', 'organize.assemble'),
  cmd('replace-pages', 'command.replace-pages.label', 'organize.assemble'),
  aliased(
    cmd('split-document', 'command.split-document.label', 'organize.assemble'),
    'command.split-document.keywords',
  ),
  aliased(
    cmd(
      'combine-files-into-pdf',
      'command.combine-files-into-pdf.label',
      'organize.assemble',
      OPEN_ANYTIME,
    ),
    'command.combine-files-into-pdf.keywords',
  ),
  cmd('crop-pages', 'command.crop-pages.label', 'organize.setup'),
  cmd('page-labels', 'command.page-labels.label', 'organize.setup'),
  cmd('add-header-footer', 'command.add-header-footer.label', 'organize.marks'),
  cmd('add-bates-numbers', 'command.add-bates-numbers.label', 'organize.marks'),
  cmd('add-watermark', 'command.add-watermark.label', 'organize.marks'),
  cmd('add-background', 'command.add-background.label', 'organize.marks'),

  // Protect
  aliased(
    {
      ...cmd('redact', 'command.redact.label', 'protect.redact'),
      checked: (state) => state.redacting,
    },
    'command.redact.keywords',
  ),
  cmd('mark-text', 'command.mark-text.label', 'protect.redact'),
  cmd('mark-whole-pages', 'command.mark-whole-pages.label', 'protect.redact'),
  cmd('redaction-properties', 'command.redaction-properties.label', 'protect.redact', ALWAYS),
  cmd('apply-redactions', 'command.apply-redactions.label', 'protect.redact', CAN_APPLY_REDACTIONS),
  aliased(
    cmd('sanitize-document', 'command.sanitize-document.label', 'protect.cleanup'),
    'command.sanitize-document.keywords',
  ),
  aliased(
    cmd('encrypt-with-password', 'command.encrypt-with-password.label', 'protect.security'),
    'command.encrypt-with-password.keywords',
  ),
  aliased(
    cmd('remove-security', 'command.remove-security.label', 'protect.security'),
    'command.remove-security.keywords',
  ),
  cmd(
    'place-signature',
    'command.place-signature.label',
    'protect.sign',
    NEEDS_DOCUMENT,
    'signing',
  ),
  cmd('sign-document', 'command.sign-document.label', 'protect.sign', NEEDS_DOCUMENT, 'signing'),
  cmd(
    'request-signatures',
    'command.request-signatures.label',
    'protect.sign',
    NEEDS_DOCUMENT,
    'signing',
  ),

  // Comment
  // The three comment tools (W7.1a) are toggles: each is pressed while it is the tool on.
  {
    ...cmd('highlight', 'command.highlight.label', 'comment.markup'),
    checked: (state) => state.commentTool === 'highlight',
  },
  cmd('underline', 'command.underline.label', 'comment.markup'),
  cmd('strikethrough', 'command.strikethrough.label', 'comment.markup'),
  cmd('squiggly', 'command.squiggly.label', 'comment.markup'),
  {
    ...cmd('sticky-note', 'command.sticky-note.label', 'comment.comments'),
    checked: (state) => state.commentTool === 'note',
  },
  cmd('text-box', 'command.text-box.label', 'comment.comments'),
  cmd('callout', 'command.callout.label', 'comment.comments'),
  cmd('stamp', 'command.stamp.label', 'comment.comments'),
  cmd('attach-file', 'command.attach-file.label', 'comment.comments'),
  {
    ...cmd('rectangle', 'command.rectangle.label', 'comment.drawing'),
    checked: (state) => state.commentTool === 'rectangle',
  },
  cmd('oval', 'command.oval.label', 'comment.drawing'),
  cmd('line', 'command.line.label', 'comment.drawing'),
  cmd('arrow', 'command.arrow.label', 'comment.drawing'),
  cmd('polygon', 'command.polygon.label', 'comment.drawing'),
  cmd('polyline', 'command.polyline.label', 'comment.drawing'),
  cmd('pen', 'command.pen.label', 'comment.drawing'),
  cmd('comments-list', 'command.comments-list.label', 'comment.manage'),
  cmd('delete-comment', 'command.delete-comment.label', 'comment.manage'),
  cmd('flatten-all-comments', 'command.flatten-all-comments.label', 'comment.manage'),
  cmd('export-comments', 'command.export-comments.label', 'comment.manage'),
  cmd('import-comments', 'command.import-comments.label', 'comment.manage'),

  // View
  cmd('zoom-out', 'command.zoom-out.label', 'view.zoom'),
  cmd('zoom-in', 'command.zoom-in.label', 'view.zoom'),
  cmd('fit-width', 'command.fit-width.label', 'view.zoom'),
  cmd('fit-page', 'command.fit-page.label', 'view.zoom'),
  cmd('actual-size', 'command.actual-size.label', 'view.zoom'),
  cmd('single-page', 'command.single-page.label', 'view.display'),
  cmd('single-page-continuous', 'command.single-page-continuous.label', 'view.display'),
  cmd('two-up-continuous', 'command.two-up-continuous.label', 'view.display'),
  cmd('two-up-with-cover-page', 'command.two-up-with-cover-page.label', 'view.display'),
  cmd('rotate-view-counterclockwise', 'command.rotate-view-counterclockwise.label', 'view.reading'),
  cmd('rotate-view-clockwise', 'command.rotate-view-clockwise.label', 'view.reading'),
  cmd('night-reading', 'command.night-reading.label', 'view.reading'),

  // Tools
  cmd('recognize-text-ocr', 'command.recognize-text-ocr.label', 'tools.ocr', NEEDS_DOCUMENT, 'ocr'),
  cmd('batch-ocr', 'command.batch-ocr.label', 'tools.ocr', OPEN_ANYTIME, 'ocr'),
  cmd('export-pdf', 'command.export-pdf.label', 'tools.export'),
  cmd('extract-images', 'command.extract-images.label', 'tools.export'),
  cmd('extract-fonts', 'command.extract-fonts.label', 'tools.export'),
  cmd(
    'create-pdf-from-office-file',
    'command.create-pdf-from-office-file.label',
    'tools.create',
    OPEN_ANYTIME,
    'office_import',
  ),
  aliased(
    cmd('reduce-file-size', 'command.reduce-file-size.label', 'tools.optimize'),
    'command.reduce-file-size.keywords',
  ),
  cmd('space-usage', 'command.space-usage.label', 'tools.optimize'),
  cmd('compare-files', 'command.compare-files.label', 'tools.compare'),
  cmd(
    'pdf-a-preflight',
    'command.pdf-a-preflight.label',
    'tools.standards',
    NEEDS_DOCUMENT,
    'pdfa',
  ),
  cmd('save-as-pdf-a', 'command.save-as-pdf-a.label', 'tools.standards', NEEDS_DOCUMENT, 'pdfa'),
  cmd(
    'accessibility-check',
    'command.accessibility-check.label',
    'tools.standards',
    NEEDS_DOCUMENT,
    'pdfa',
  ),
  cmd(
    'auto-tag-document-experimental',
    'command.auto-tag-document-experimental.label',
    'tools.standards',
    NEEDS_DOCUMENT,
    'pdfa',
  ),

  // App menu only
  cmd('close', 'command.close.label', 'app.file'),
  // Palette and keys only, not in the menu (W4.3b D7). They wrap, and need a document as the other
  // document commands do (D6).
  cmd('next-document', 'command.next-document.label', 'app.file'),
  cmd('previous-document', 'command.previous-document.label', 'app.file'),
  cmd('open-recent', 'command.open-recent.label', 'app.file', HAS_RECENT),
  cmd('save-as', 'command.save-as.label', 'app.file'),
  cmd('preferences', 'command.preferences.label', 'app.settings', OPEN_ANYTIME),
  cmd('keyboard-shortcuts', 'command.keyboard-shortcuts.label', 'app.settings', OPEN_ANYTIME),
  cmd('help', 'command.help.label', 'app.help', OPEN_ANYTIME),
  cmd('whats-different', 'command.whats-different.label', 'app.help', OPEN_ANYTIME),
  cmd('install-app', 'command.install-app.label', 'app.help', OPEN_ANYTIME, 'pwa_install'),
  cmd('about-elanero', 'command.about-elanero.label', 'app.help', OPEN_ANYTIME),

  // Ribbon forms (W4.3a S2): not in the app menu; Ctrl+F1 is the shared key of collapse-ribbon.
  cmd('collapse-ribbon', 'command.collapse-ribbon.label', 'app.ribbon', OPEN_ANYTIME),
  {
    ...cmd('compact-ribbon', 'command.compact-ribbon.label', 'app.ribbon', OPEN_ANYTIME),
    checked: (state) => state.ribbonCompact,
  },
];

export const COMMANDS: readonly CommandDef[] = DECLARED_COMMANDS.map((def) => {
  const icon = ICON_OVERRIDES[def.id];
  return icon === undefined ? def : { ...def, icon };
});

// The app menu's sections, in W1.6 section 6 order (a separator between sections).
export const MENU: readonly (readonly string[])[] = [
  ['open', 'open-recent', 'save', 'save-as', 'print', 'document-properties', 'close'],
  ['preferences', 'keyboard-shortcuts'],
  ['help', 'whats-different', 'install-app', 'about-elanero'],
];

// The header's quick-access buttons, in the desktop's order (W1.6 section 2). Below 1024 px only
// the last three stay (the table in W1.6 section 8 keeps Undo, Redo and Save).
export const QUICK_ACCESS: readonly string[] = ['select-tool', 'hand-tool', 'undo', 'redo', 'save'];
export const QUICK_ACCESS_NARROW: readonly string[] = ['undo', 'redo', 'save'];

export const REGISTRY: Registry = createRegistry(COMMANDS, GROUPS, MENU);
