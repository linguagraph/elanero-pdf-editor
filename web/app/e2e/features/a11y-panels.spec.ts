// W8.5 S9: axe on the side panels, the ribbon tabs and the engine dialogs, in light and dark. Each
// panel, tab and dialog is its own test, so a failure names the screen. All of them need a
// document and the staged engine (STAGED), so the specs skip without it, as the other engine specs
// do. The rail and the ribbon are read from the open document; the dialogs open from the main menu
// or the command palette, as the W8.1 flows open them.
import { expect, type Page, test } from '@playwright/test';
import { checkAxe } from './axe';
import { fixture, openApp, openPdf, STAGED } from './support';

const SCHEMES = ['light', 'dark'] as const;

// Each side panel, by the name of its rail button (the panel's own title), and the fixture whose
// content it shows. Opening a panel closes the other one on its side (sidePanels.ts).
const PANELS: readonly { name: string; file: string }[] = [
  { name: 'Thumbnails', file: 'text_multipage.pdf' },
  { name: 'Bookmarks', file: 'outline.pdf' },
  { name: 'Attachments', file: 'attachments.pdf' },
  { name: 'Layers', file: 'layers.pdf' },
  { name: 'Search', file: 'text_multipage.pdf' },
  { name: 'Redactions', file: 'text_multipage.pdf' },
  { name: 'Comments', file: 'text_multipage.pdf' },
  { name: 'Organize pages', file: 'text_multipage.pdf' },
];

// The seven ribbon tabs, by their visible name.
const TABS = ['Home', 'Edit', 'Organize', 'Protect', 'Comment', 'View', 'Tools'] as const;

// Opens the app with one document (the five-page fixture unless the panel needs another).
async function openDocument(page: Page, file = 'text_multipage.pdf'): Promise<void> {
  await openApp(page);
  await openPdf(page, file, fixture(file));
}

// Runs a command from the command palette: the query fills the search box, then the first option
// whose name starts with `option` is chosen. The option's name also holds its tab and shortcut.
async function runCommand(page: Page, query: string, option: RegExp): Promise<void> {
  await page.getByRole('searchbox', { name: 'Search tools' }).fill(query);
  await page.getByRole('option', { name: option }).click();
}

// Runs a command from the palette by its id: the query is one word of the label (the palette matches
// labels and keywords, not ids), then the option is clicked by its data-command attribute.
async function runCommandById(page: Page, query: string, id: string): Promise<void> {
  await page.getByRole('searchbox', { name: 'Search tools' }).fill(query);
  await page.locator(`[data-command="${id}"]`).click();
}

// One dialog opener per engine dialog the jsdom checks cover (W8.5 section 2.3). Each returns once
// the dialog is open, and gives its accessible name so the test can wait for it.
interface DialogCase {
  readonly title: string;
  readonly open: (page: Page) => Promise<void>;
}

const DIALOGS: readonly DialogCase[] = [
  {
    title: 'Save As',
    open: async (page) => {
      await page.getByRole('button', { name: 'Main menu' }).click();
      await page.locator('.app-menu-item', { hasText: 'Save As…' }).click();
    },
  },
  {
    title: 'Print',
    open: async (page) => {
      await page.getByRole('button', { name: 'Main menu' }).click();
      await page.locator('.app-menu-item', { hasText: 'Print…' }).click();
    },
  },
  {
    title: 'Export pages',
    open: (page) => runCommandById(page, 'Export', 'export-pdf'),
  },
  {
    title: 'Reduce file size',
    open: (page) => runCommand(page, 'Reduce File Size', /^Reduce File Size/),
  },
  {
    title: 'Split document',
    open: (page) => runCommand(page, 'Split', /^Split/),
  },
  {
    title: 'Combine files',
    open: (page) => runCommandById(page, 'Combine', 'combine-files-into-pdf'),
  },
  {
    title: 'Document properties',
    open: (page) => runCommandById(page, 'Properties', 'document-properties'),
  },
  {
    title: 'Encrypt with Password',
    open: (page) => runCommandById(page, 'Encrypt', 'encrypt-with-password'),
  },
  {
    title: 'Flatten annotations',
    open: (page) => runCommandById(page, 'Flatten', 'flatten-all-comments'),
  },
  {
    title: 'Mark Pages',
    open: async (page) => {
      await page.locator('.ribbon [role="tab"]', { hasText: 'Protect' }).click();
      await page.getByRole('button', { name: 'Mark Pages', exact: true }).click();
    },
  },
];

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  for (const scheme of SCHEMES) {
    test.describe(`${scheme} scheme`, () => {
      test.use({ colorScheme: scheme });

      for (const panel of PANELS) {
        test(`axe: ${panel.name} panel (${scheme})`, async ({ page }, testInfo) => {
          await openDocument(page, panel.file);
          await page.getByRole('button', { name: panel.name, exact: true }).click();
          await expect(page.getByRole('button', { name: panel.name, exact: true })).toHaveAttribute(
            'aria-expanded',
            'true',
          );
          await checkAxe(page, testInfo);
        });
      }

      for (const tab of TABS) {
        test(`axe: ${tab} ribbon tab (${scheme})`, async ({ page }, testInfo) => {
          await openDocument(page);
          await page.locator('.ribbon [role="tab"]', { hasText: tab }).click();
          await expect(page.locator('.ribbon [role="tab"][aria-selected="true"]')).toContainText(
            tab,
          );
          await checkAxe(page, testInfo);
        });
      }

      for (const dialog of DIALOGS) {
        test(`axe: ${dialog.title} dialog (${scheme})`, async ({ page }, testInfo) => {
          await openDocument(page);
          await dialog.open(page);
          await expect(page.getByRole('dialog', { name: dialog.title, exact: true })).toBeVisible();
          await checkAxe(page, testInfo);
        });
      }
    });
  }
});
