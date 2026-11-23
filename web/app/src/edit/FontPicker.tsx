// The font picker of the style bar (W6.8b slice 2, design section 4.4): an editable combobox over a
// popup listbox with one group per section. Headings are labels, not options, so the arrow keys
// move between fonts only. Typing filters the shown names; Enter picks; Escape closes the popup and
// keeps the bar. Options are drawn in the UI font (loading each document font would cost a
// content.preview_font call per font).
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { UPLOAD_KEY, type FontOption, type FontSection } from './fontList';

// The roving-focus props of one bar control (the bar's tab stop; see StyleBar).
export interface StopProps {
  readonly 'data-stop': true;
  readonly tabIndex: number;
  readonly onFocus: () => void;
}

export interface FontPickerProps {
  readonly sections: readonly FontSection[];
  readonly selected: FontOption;
  readonly stop: StopProps;
  readonly onPick: (option: FontOption) => void;
  // Opens the file dialog for the Uploaded section's "Upload font…" row.
  readonly onUpload?: () => void;
}

export function FontPicker({ sections, selected, stop, onPick, onUpload }: FontPickerProps) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  // What the user typed; null while the box shows the selected font.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const needle = (query ?? '').trim().toLowerCase();
  const shown = sections
    .map((s) => ({
      ...s,
      options:
        needle === '' ? s.options : s.options.filter((o) => o.label.toLowerCase().includes(needle)),
    }))
    .filter((s) => s.options.length > 0);
  const flat = shown.flatMap((s) => s.options);
  // The upload row is never the default: a filter can leave it first, and Enter must not open the
  // file dialog. The arrow keys still reach it, and an explicit move keeps it active.
  const defaultKey = flat.find((o) => o.key !== UPLOAD_KEY)?.key ?? null;
  const activeKey = flat.some((o) => o.key === active) ? active : defaultKey;
  const optionId = (key: string) => `${id}-o${flat.findIndex((o) => o.key === key)}`;

  // Keeps the highlighted font in view when the list scrolls.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeKey]);

  const close = () => {
    setOpen(false);
    setQuery(null);
    setActive(null);
  };

  const pick = (option: FontOption) => {
    close();
    if (option.key === UPLOAD_KEY) onUpload?.();
    else onPick(option);
  };

  const move = (step: 1 | -1) => {
    if (flat.length === 0) return;
    const index = flat.findIndex((o) => o.key === activeKey);
    const next = (index + step + flat.length) % flat.length;
    setActive(flat[next]?.key ?? null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const chosen = open ? flat.find((o) => o.key === activeKey) : undefined;
      if (chosen !== undefined) pick(chosen);
      else setOpen(true);
      return;
    }
    if (event.key === 'Escape' && open) {
      // Escape closes the popup only: the bar and the text keep their state.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div className="edit-font-picker">
      <input
        type="text"
        className="edit-font-input"
        role="combobox"
        aria-label={t('edit.style.font')}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeKey !== null ? optionId(activeKey) : undefined}
        autoComplete="off"
        spellCheck={false}
        title={selected.title}
        value={query ?? selected.label}
        {...stop}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(null);
          setOpen(true);
        }}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      {open ? (
        // A press anywhere in the popup (a heading, the empty row, the padding) keeps focus in
        // the input, so the blur does not close the popup or drop the typed filter.
        <div className="edit-font-popup" onMouseDown={(event) => event.preventDefault()}>
          <div role="listbox" id={listId} ref={listRef} aria-label={t('edit.style.font')}>
            {shown.map((section) => {
              const headingId = `${id}-${section.id}`;
              return (
                <div role="group" aria-labelledby={headingId} key={section.id}>
                  <div id={headingId} className="edit-font-heading">
                    {section.heading}
                  </div>
                  {section.options.map((option) => (
                    <div
                      key={option.key}
                      id={optionId(option.key)}
                      role="option"
                      aria-selected={option.key === activeKey}
                      className="edit-font-option"
                      data-current={option.key === selected.key ? 'true' : undefined}
                      title={option.title}
                      // A press on an option picks it without moving focus out of the input.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(option)}
                    >
                      {option.label}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {flat.length === 0 ? (
            <div role="status" className="edit-font-empty">
              {t('fonts.picker.noMatch')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
