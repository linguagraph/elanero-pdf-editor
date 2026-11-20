// The Redactions side panel (W7.4b S4, W1.6 section 4): the document's redaction marks, as a list.
// A row shows the page, the marked text (or "Area"), the overlay text and a swatch of the box
// colour. The list is a multi-select listbox: a click picks one row, Ctrl or Space toggles a row,
// Shift extends from the anchor. Enter or a double-click goes to the mark's page. The selection is
// outlined in the viewer. Delete removes the selected marks as one undo step (the controller). The
// properties of the selection (fill, text colour, overlay text) are edited in place, and Apply
// Selected and Apply All burn the marks into the document after a confirmation (W7.4b S5).
import { type KeyboardEvent, useId, useRef, useState, useSyncExternalStore } from 'react';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import { ApplyConfirm } from './ApplyConfirm';
import { isSelectedMark, type RedactionController, type RedactionMark } from './controller';
import { type MarkStyleField, MarkStyleFields, type MarkStyleValues } from './MarkStyleFields';
import './redaction.css';

export interface RedactionsPanelProps {
  readonly controller: RedactionController;
  // Called with the page index (zero-based) to bring into view.
  readonly onGoTo: (page: number) => void;
  readonly onClose: () => void;
}

// The value each property shows for the selection: the one value when every mark agrees, else the
// first mark's value with the field marked mixed (the editor shows it empty).
function sharedStyle(marks: readonly RedactionMark[]): {
  values: MarkStyleValues;
  mixed: Partial<Record<MarkStyleField, boolean>>;
} {
  const first = marks[0];
  if (first === undefined) {
    return { values: { fill: null, textColor: null, overlayText: '' }, mixed: {} };
  }
  const differs = (pick: (mark: RedactionMark) => unknown) =>
    marks.some((mark) => JSON.stringify(pick(mark)) !== JSON.stringify(pick(first)));
  const mixed = {
    fill: differs((mark) => mark.fill),
    textColor: differs((mark) => mark.textColor),
    overlayText: differs((mark) => mark.overlayText),
  };
  return {
    values: {
      fill: first.fill,
      textColor: first.textColor,
      overlayText: mixed.overlayText ? '' : first.overlayText,
    },
    mixed,
  };
}

// The swatch of a box: its fill, or black when the file has none (the engine draws it black).
function swatchStyle(mark: RedactionMark): { background: string } {
  const fill = mark.fill ?? { r: 0, g: 0, b: 0 };
  const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return { background: `rgb(${channel(fill.r)} ${channel(fill.g)} ${channel(fill.b)})` };
}

export function RedactionsPanel({ controller, onGoTo, onClose }: RedactionsPanelProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const hintId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // The row with the keyboard focus (roving tabindex); null until the user reaches the list.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  // The row a Shift-click extends the selection from.
  const [anchor, setAnchor] = useState<number | null>(null);
  // Which apply is waiting for the user's confirmation, if any.
  const [confirming, setConfirming] = useState<'selected' | 'all' | null>(null);

  const { marks, selected, busy, loaded } = state;
  const selectedMarks = marks.filter((mark) => isSelectedMark(selected, mark));
  const selectedCount = selectedMarks.length;
  const selectedRefs = selectedMarks.map((mark) => ({ page: mark.page, name: mark.name }));
  const style = sharedStyle(selectedMarks);
  // A locked mark keeps its style, so the editor is off while the selection holds one.
  const locked = selectedMarks.some((mark) => mark.locked);
  // Remounts the editor when the selection or the values change from outside (an undo, a reload),
  // so its typed overlay text starts from the value the document has.
  const editorKey = `${selectedRefs.map((ref) => `${ref.page}:${ref.name}`).join('|')}#${JSON.stringify(style)}`;
  const rowIndex = Math.min(
    focusIndex ?? marks.findIndex((m) => isSelectedMark(selected, m)),
    marks.length - 1,
  );
  const activeIndex = rowIndex < 0 ? 0 : rowIndex;

  const refsOf = (indices: readonly number[]) =>
    indices
      .map((index) => marks[index])
      .filter((mark): mark is RedactionMark => mark !== undefined)
      .map((mark) => ({ page: mark.page, name: mark.name }));

  const choose = (
    index: number,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => {
    setFocusIndex(index);
    if (event.shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      controller.select(refsOf(range(from, to)));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const current = marks.flatMap((mark, i) => (isSelectedMark(selected, mark) ? [i] : []));
      const next = current.includes(index)
        ? current.filter((i) => i !== index)
        : [...current, index];
      controller.select(refsOf(next));
      setAnchor(index);
      return;
    }
    controller.select(refsOf([index]));
    setAnchor(index);
  };

  const focusRow = (index: number) => {
    setFocusIndex(index);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The row the key was pressed on; the focused row when the target is not a row.
    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-index]') : null;
    const index = target === null ? activeIndex : Number(target.getAttribute('data-index'));
    const mark = marks[index];
    if (mark === undefined) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = clamp(index + (event.key === 'ArrowDown' ? 1 : -1), marks.length);
      if (event.shiftKey) choose(next, event);
      else {
        focusRow(next);
        controller.select(refsOf([next]));
        setAnchor(next);
      }
    } else if (event.key === ' ') {
      event.preventDefault();
      choose(index, { ctrlKey: true, metaKey: false, shiftKey: false });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onGoTo(mark.page);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (!busy && selectedCount > 0) void controller.remove(selected);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      controller.select([]);
      setAnchor(null);
    }
  };

  let body;
  if (!loaded) {
    body = (
      <p role="status" className="redactions-status">
        {t('redactions.loading')}
      </p>
    );
  } else if (marks.length === 0) {
    body = (
      <p role="status" className="redactions-status">
        {t('redactions.empty')}
      </p>
    );
  } else {
    body = (
      <>
        <div className="redactions-toolbar">
          <button
            type="button"
            onClick={() => void controller.remove(selected)}
            disabled={busy || selectedCount === 0}
          >
            {t('redactions.delete')}
          </button>
          <button
            type="button"
            onClick={() => setConfirming('selected')}
            disabled={busy || selectedCount === 0}
          >
            {t('redactions.applySelected')}
          </button>
          <button type="button" onClick={() => setConfirming('all')} disabled={busy}>
            {t('redactions.applyAll')}
          </button>
        </div>
        {selectedCount === 0 ? null : (
          <section className="redactions-properties" aria-label={t('redactions.properties')}>
            <MarkStyleFields
              key={editorKey}
              value={style.values}
              mixed={style.mixed}
              disabled={busy || locked}
              onChange={(patch) => void controller.restyle(selectedRefs, patch)}
            />
            {locked ? <p className="redactions-status">{t('redactions.locked')}</p> : null}
          </section>
        )}
        <div
          ref={listRef}
          role="listbox"
          aria-multiselectable="true"
          aria-label={t('redactions.list')}
          aria-describedby={hintId}
          className="redactions-list panel-fill"
          onKeyDown={onKeyDown}
        >
          {marks.map((mark, index) => {
            const isSelected = isSelectedMark(selected, mark);
            return (
              <div
                key={`${mark.page}:${mark.name}`}
                role="option"
                aria-selected={isSelected}
                className="redactions-row"
                data-index={index}
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setFocusIndex(index)}
                onClick={(event) => choose(index, event)}
                onDoubleClick={() => onGoTo(mark.page)}
              >
                <span className="redactions-swatch" style={swatchStyle(mark)} aria-hidden="true" />
                <span className="redactions-main">
                  <span className="redactions-where">
                    {t('redactions.page', { page: mark.page + 1 })}
                  </span>
                  <span className="redactions-text">
                    {mark.contents === '' ? t('redactions.area') : mark.contents}
                  </span>
                  {mark.overlayText === '' ? null : (
                    <span className="redactions-text redactions-overlay">
                      {t('redactions.overlay', { text: mark.overlayText })}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <p id={hintId} className="visually-hidden">
          {t('redactions.hint')}
        </p>
      </>
    );
  }

  return (
    <Panel title={t('redactions.title')} onClose={onClose}>
      {body}
      <ApplyConfirm
        isOpen={confirming !== null}
        count={confirming === 'all' ? marks.length : selectedCount}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const scope = confirming;
          setConfirming(null);
          void controller.apply(scope === 'all' ? null : selectedRefs);
        }}
      />
    </Panel>
  );
}

function clamp(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
