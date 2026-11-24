// The stamp menu (W7.3 S6, W7.3b S2): the standard stamps, then the user's own PNG or JPEG stamps
// with thumbnails, Add Custom Stamp and Remove Custom Stamp. Choosing one makes the stamp tool the
// active comment tool; a click on a page then places that stamp (CommentLayer). The menu is
// react-aria's, so arrows, Enter, typeahead and Escape work. The library is read each time the menu
// opens, so a stamp added in another tab shows up (W7.3b section 3.4).
import { useRef, useState } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Section,
  Separator,
  SubmenuTrigger,
} from 'react-aria-components';
import { type ToastStore, toasts } from '../feedback/toasts';
import { pickFile } from '../files/pickFile';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import type { BlobLike } from '../storage/opfs';
import { type ChosenStamp, STAMP_LABEL, STANDARD_STAMPS, type StandardStamp } from './stamps';
import { type HeldReason, type LibraryStamp, type StampLibrary, refusalText } from './stampLibrary';

const PICK_ACCEPT = 'image/png,image/jpeg,.png,.jpg,.jpeg';
// What a stamp kept for this tab only says (W7.3b section 3.2, step 6).
const HELD_TEXT: Readonly<Record<HeldReason, MessageId>> = {
  unsupported: 'stamp.custom.sessionOnly',
  noSpace: 'stamp.custom.noSpace',
  failed: 'stamp.custom.saveFailed',
};

// What the open menu shows: the library, each stamp's thumbnail URL, and whether the browser keeps
// nothing (the stamps then go when the tab closes).
interface Shown {
  readonly stamps: readonly LibraryStamp[];
  readonly thumbs: ReadonlyMap<string, string>;
  readonly sessionOnly: boolean;
}

const NOTHING_SHOWN: Shown = { stamps: [], thumbs: new Map(), sessionOnly: false };

export interface StampMenuProps {
  readonly library: StampLibrary;
  readonly onChoose: (stamp: ChosenStamp) => void;
  // A custom stamp was removed; the caller falls back when it was the current one.
  readonly onRemoved: (id: string) => void;
  readonly store?: ToastStore;
}

export function StampMenu({ library, onChoose, onRemoved, store = toasts }: StampMenuProps) {
  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);
  // Thumbnail URLs are revoked when the menu closes. Each open and each close takes a new token; a
  // load whose token is no longer current (the menu closed, or a newer open began) revokes the URLs
  // it made and changes nothing else.
  const token = useRef(0);
  const urls = useRef<readonly string[]>([]);

  async function load(): Promise<void> {
    const mine = ++token.current;
    const stamps = await library.list();
    const storage = await library.storage();
    const thumbs = new Map<string, string>();
    await Promise.all(
      stamps.map(async (stamp) => {
        // A stamp whose picture cannot be read shows no thumbnail; the menu still opens.
        const blob: BlobLike | undefined = await library.read(stamp.id).catch(() => undefined);
        // The store reads a File, which is a Blob; the cast is for the BlobLike type only.
        if (blob !== undefined) thumbs.set(stamp.id, URL.createObjectURL(blob as Blob));
      }),
    );
    if (mine !== token.current) {
      for (const url of thumbs.values()) URL.revokeObjectURL(url);
      return;
    }
    urls.current = [...thumbs.values()];
    setShown({ stamps, thumbs, sessionOnly: storage === 'session' });
  }

  function close(): void {
    token.current++;
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current = [];
    setShown(NOTHING_SHOWN);
  }

  // Add runs the library's checks, then chooses the stamp (desktop add_custom calls on_choose).
  async function addPicked(file: File): Promise<void> {
    const outcome = await library.add(file);
    if (outcome.kind === 'refused') {
      store.push('error', refusalText(outcome.reason));
      return;
    }
    const { stamp } = outcome;
    if (outcome.kind === 'held') store.push('warning', t(HELD_TEXT[outcome.reason]));
    else if (outcome.kind === 'already') {
      store.push('info', t('stamp.custom.already', { name: stamp.label }));
    } else store.push('success', t('stamp.custom.added', { name: stamp.label }));
    onChoose({ kind: 'custom', id: stamp.id, label: stamp.label });
  }

  async function remove(stamp: LibraryStamp): Promise<void> {
    if (!(await library.remove(stamp.id))) {
      store.push('error', t('stamp.custom.removeFailed'));
      return;
    }
    store.push('success', t('stamp.custom.removed', { name: stamp.label }));
    onRemoved(stamp.id);
  }

  function choose(key: string): void {
    if (key === 'add') {
      // The picker opens from this click, which the browser requires.
      void pickFile(PICK_ACCEPT)
        .then((file) => (file === null ? undefined : addPicked(file)))
        .catch(() => store.push('error', t('stamp.custom.saveFailed')));
      return;
    }
    if (key.startsWith('custom:')) {
      const custom = shown.stamps.find((stamp) => `custom:${stamp.id}` === key);
      if (custom !== undefined) onChoose({ kind: 'custom', id: custom.id, label: custom.label });
      return;
    }
    onChoose({ kind: 'standard', name: key as StandardStamp });
  }

  const hasCustom = shown.stamps.length > 0;

  return (
    <MenuTrigger
      onOpenChange={(open) => {
        if (open) {
          // A failed list or storage read leaves the menu with its standard stamps only.
          load().catch(() => undefined);
        } else close();
      }}
    >
      <Button className="stamp-menu-button">{t('stamp.menu')}</Button>
      <Popover className="app-menu-popover">
        {shown.sessionOnly ? (
          <p className="app-menu-note">{t('stamp.custom.sessionOnly')}</p>
        ) : null}
        <Menu
          aria-label={t('stamp.menuLabel')}
          className="app-menu"
          onAction={(key) => choose(String(key))}
        >
          {STANDARD_STAMPS.map((name) => (
            <MenuItem key={name} id={name} className="app-menu-item">
              {t(STAMP_LABEL[name])}
            </MenuItem>
          ))}
          {hasCustom ? <Separator className="app-menu-separator" /> : null}
          {hasCustom ? (
            <Section aria-label={t('stamp.custom.section')}>
              {shown.stamps.map((stamp) => {
                const url = shown.thumbs.get(stamp.id);
                return (
                  <MenuItem
                    key={stamp.id}
                    id={`custom:${stamp.id}`}
                    textValue={stamp.label}
                    className="app-menu-item"
                  >
                    {url === undefined ? null : (
                      // Decorative: the label beside it is the item's name, so the alt is empty.
                      <img className="stamp-menu-thumb" src={url} alt={''} decoding="async" />
                    )}
                    {stamp.label}
                  </MenuItem>
                );
              })}
            </Section>
          ) : null}
          <Separator className="app-menu-separator" />
          <MenuItem id="add" className="app-menu-item">
            {t('stamp.custom.add')}
          </MenuItem>
          <SubmenuTrigger>
            <MenuItem id="remove" className="app-menu-item" isDisabled={!hasCustom}>
              {t('stamp.custom.remove')}
            </MenuItem>
            <Popover className="app-menu-popover">
              <Menu
                aria-label={t('stamp.custom.remove')}
                className="app-menu"
                onAction={(key) => {
                  const stamp = shown.stamps.find((s) => s.id === String(key));
                  if (stamp !== undefined) void remove(stamp);
                }}
              >
                {shown.stamps.map((stamp) => (
                  <MenuItem
                    key={stamp.id}
                    id={stamp.id}
                    textValue={stamp.label}
                    className="app-menu-item"
                  >
                    {stamp.label}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </SubmenuTrigger>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
