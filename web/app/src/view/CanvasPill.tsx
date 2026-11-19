// The canvas pill (W4.2a S5, W1.6 section 4, the desktop's ui/view/pill.py): the page navigator,
// the zoom box with its presets, the zoom minus and plus, and the fit width and fit page buttons.
// It floats at the bottom centre of the page area and fades after a few seconds without use. It
// keeps no zoom or page state of its own: the document view passes them in and handles the calls.
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { PageJumpField } from './PageJumpField';
import { MAX_ZOOM, MIN_ZOOM } from './zoom';
import { parseZoomInput, ZOOM_PRESETS, type ZoomRequest } from './zoomBox';
import './canvasPill.css';

// How long the pill stays shown after the last pointer move, scroll or focus (desktop: 3 s).
export const FADE_AFTER_MS = 3000;

type Preset = (typeof ZOOM_PRESETS)[number];

export interface CanvasPillProps {
  // One-based page at the middle of the viewport, and the number of pages.
  readonly page: number;
  readonly total: number;
  // The document's page labels, one per page; empty when it has none.
  readonly labels: readonly string[];
  readonly zoom: number;
  // The fit mode in effect, if any; the fit buttons show which one.
  readonly fit: 'width' | 'page' | null;
  // Called with a zero-based page index for a jump, and with -1 or 1 for the previous or next page.
  onGoTo(index: number): void;
  onStep(direction: -1 | 1): void;
  onZoom(request: ZoomRequest): void;
  onZoomStep(direction: -1 | 1): void;
}

// The label of a zoom preset in the list: the fit names, or the percentage.
function presetLabel(preset: Preset): string {
  if (preset === 'fitWidth') return t('view.fitWidth');
  if (preset === 'fitPage') return t('view.fitPage');
  return t('view.zoomPercent', { percent: Math.round(preset * 100) });
}

// The request a preset makes: a fit mode, or the zoom it names.
function presetRequest(preset: Preset): ZoomRequest {
  if (preset === 'fitWidth') return { fit: 'width' };
  if (preset === 'fitPage') return { fit: 'page' };
  return { zoom: preset };
}

export function CanvasPill({
  page,
  total,
  labels,
  zoom,
  fit,
  onGoTo,
  onStep,
  onZoom,
  onZoomStep,
}: CanvasPillProps) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  // What keeps the pill shown: the pointer over it, focus in it, or the preset list open.
  const hovered = useRef(false);
  const focused = useRef(false);
  const listing = useRef(false);
  const [shown, setShown] = useState(true);
  // False when the page area is narrower than the pill: the pill is then hidden (desktop _place).
  const [fits, setFits] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  // The zoom text being typed; null while the box shows the zoom.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const hintId = useId();
  const listId = useId();

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // Shows the pill and, unless something holds it, starts the countdown to the fade.
  const arm = useCallback(() => {
    clearTimer();
    setShown(true);
    if (hovered.current || focused.current || listing.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setShown(false);
    }, FADE_AFTER_MS);
  }, [clearTimer]);

  // Records one of the holds and re-arms: a held pill stays shown, a released one fades later.
  const hold = useCallback(
    (part: 'hovered' | 'focused' | 'listing', on: boolean) => {
      if (part === 'hovered') hovered.current = on;
      else if (part === 'focused') focused.current = on;
      else listing.current = on;
      arm();
    },
    [arm],
  );

  // The page area's pointer moves and scrolls show the pill; the area is the parent element. The
  // width check hides the pill when the area is narrower than the pill itself.
  useEffect(() => {
    const pill = ref.current;
    const area = pill?.parentElement;
    if (pill === null || area === null || area === undefined) return;
    const onActivity = () => arm();
    const measure = () => {
      const width = area.clientWidth;
      setFits(width === 0 || pill.offsetWidth <= width);
    };
    area.addEventListener('pointermove', onActivity);
    area.addEventListener('scroll', onActivity, { capture: true, passive: true });
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(area);
    measure();
    arm();
    return () => {
      area.removeEventListener('pointermove', onActivity);
      area.removeEventListener('scroll', onActivity, { capture: true });
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      clearTimer();
    };
  }, [arm, clearTimer]);

  const percent = Math.round(zoom * 100);

  const submitZoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft ?? `${percent}%`;
    const request = parseZoomInput(text);
    if (request === null) {
      setInvalid(t('pill.zoomInvalid', { input: text.trim() }));
      return;
    }
    setInvalid(null);
    setDraft(null);
    onZoom(request);
  };

  const chooseListed = (preset: Preset) => {
    setInvalid(null);
    setDraft(null);
    setListOpen(false);
    hold('listing', false);
    onZoom(presetRequest(preset));
  };

  const closeList = () => {
    setListOpen(false);
    hold('listing', false);
  };

  return (
    <div
      ref={ref}
      className="canvas-pill"
      role="toolbar"
      aria-label={t('pill.label')}
      data-shown={shown ? 'true' : 'false'}
      hidden={!fits}
      onPointerEnter={() => hold('hovered', true)}
      onPointerLeave={() => hold('hovered', false)}
      onFocus={() => hold('focused', true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          hold('focused', false);
        }
      }}
    >
      <div className="canvas-pill-group">
        <button
          type="button"
          aria-label={t('pill.previousPage')}
          disabled={page <= 1}
          onClick={() => onStep(-1)}
        >
          {'‹'}
        </button>
        <PageJumpField page={page} total={total} labels={labels} onGoTo={onGoTo} />
        <button
          type="button"
          aria-label={t('pill.nextPage')}
          disabled={page >= total}
          onClick={() => onStep(1)}
        >
          {'›'}
        </button>
      </div>
      <div className="canvas-pill-group">
        <button
          type="button"
          aria-label={t('view.zoomOut')}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => onZoomStep(-1)}
        >
          {'−'}
        </button>
        <form
          className="canvas-pill-zoom"
          onSubmit={submitZoom}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && listOpen) closeList();
          }}
        >
          <input
            className="canvas-pill-zoom-input"
            type="text"
            inputMode="text"
            aria-label={t('pill.zoom')}
            aria-describedby={hintId}
            aria-invalid={invalid !== null}
            value={draft ?? `${percent}%`}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(null);
            }}
            onBlur={() => {
              setDraft(null);
              setInvalid(null);
            }}
          />
          <span id={hintId} className="canvas-pill-hint">
            {t('pill.zoomHint')}
          </span>
          <button
            type="button"
            aria-label={t('pill.zoomPresets')}
            aria-expanded={listOpen}
            aria-controls={listId}
            onClick={() => {
              const open = !listOpen;
              setListOpen(open);
              hold('listing', open);
            }}
          >
            {'▾'}
          </button>
          {listOpen ? (
            <ul id={listId} className="canvas-pill-presets">
              {ZOOM_PRESETS.map((preset) => (
                <li key={String(preset)}>
                  <button type="button" onClick={() => chooseListed(preset)}>
                    {presetLabel(preset)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {invalid === null ? null : (
            <span role="alert" className="canvas-pill-error">
              {invalid}
            </span>
          )}
        </form>
        <button
          type="button"
          aria-label={t('view.zoomIn')}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => onZoomStep(1)}
        >
          {'+'}
        </button>
      </div>
      <div className="canvas-pill-group">
        <button
          type="button"
          aria-pressed={fit === 'width'}
          onClick={() => onZoom({ fit: 'width' })}
        >
          {t('view.fitWidth')}
        </button>
        <button type="button" aria-pressed={fit === 'page'} onClick={() => onZoom({ fit: 'page' })}>
          {t('view.fitPage')}
        </button>
      </div>
    </div>
  );
}
