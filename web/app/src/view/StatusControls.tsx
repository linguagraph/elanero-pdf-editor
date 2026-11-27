// The page and zoom controls of the status bar (#808 slice 1, the desktop's ui/view/pill.py): the page
// navigator, the zoom box with its presets, the zoom minus and plus, and the fit width and fit page
// buttons. They keep no zoom or page state of their own: the host passes them in and handles the calls.
import { type FormEvent, type Ref, useId, useState } from 'react';
import { t } from '../i18n/t';
import { Icon } from '../theme/Icon';
import { PageJumpField } from './PageJumpField';
import { MAX_ZOOM, MIN_ZOOM } from './zoom';
import { parseZoomInput, ZOOM_PRESETS, type ZoomRequest } from './zoomBox';

export interface StatusControlsProps {
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
  // The page field's input, for the host to focus (the registry's Go to Page command, W4.3b).
  readonly pageFieldRef?: Ref<HTMLInputElement>;
}

type Preset = (typeof ZOOM_PRESETS)[number];

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

export function StatusControls({
  page,
  total,
  labels,
  zoom,
  fit,
  onGoTo,
  onStep,
  onZoom,
  onZoomStep,
  pageFieldRef,
}: StatusControlsProps) {
  const [listOpen, setListOpen] = useState(false);
  // The zoom text being typed; null while the box shows the zoom.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const hintId = useId();
  const listId = useId();

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
    onZoom(presetRequest(preset));
  };

  return (
    <div className="doc-status-controls" role="toolbar" aria-label={t('pill.label')}>
      <div className="doc-status-group">
        <button
          type="button"
          aria-label={t('pill.previousPage')}
          title={t('pill.previousPage')}
          disabled={page <= 1}
          onClick={() => onStep(-1)}
        >
          <Icon name="chevron-left" />
        </button>
        <PageJumpField
          ref={pageFieldRef}
          page={page}
          total={total}
          labels={labels}
          onGoTo={onGoTo}
        />
        <button
          type="button"
          aria-label={t('pill.nextPage')}
          title={t('pill.nextPage')}
          disabled={page >= total}
          onClick={() => onStep(1)}
        >
          <Icon name="chevron-right" />
        </button>
      </div>
      <div className="doc-status-group">
        <button
          type="button"
          aria-label={t('view.zoomOut')}
          title={t('view.zoomOut')}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => onZoomStep(-1)}
        >
          <Icon name="minus" />
        </button>
        <form
          className="doc-status-zoom-form"
          onSubmit={submitZoom}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && listOpen) setListOpen(false);
          }}
        >
          <input
            className="doc-status-zoom-input"
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
          <span id={hintId} className="doc-status-hint">
            {t('pill.zoomHint')}
          </span>
          <button
            type="button"
            aria-label={t('pill.zoomPresets')}
            title={t('pill.zoomPresets')}
            aria-expanded={listOpen}
            aria-controls={listId}
            onClick={() => setListOpen(!listOpen)}
          >
            <Icon name="chevron-down" />
          </button>
          {listOpen ? (
            <ul id={listId} className="doc-status-presets">
              {ZOOM_PRESETS.map((preset) => (
                <li key={String(preset)}>
                  <button type="button" onClick={() => chooseListed(preset)}>
                    {presetLabel(preset)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </form>
        {/* Outside the form: the form is the presets' anchor, and the error centres on the bar. */}
        {invalid === null ? null : (
          <span role="alert" className="doc-status-error">
            {invalid}
          </span>
        )}
        <button
          type="button"
          aria-label={t('view.zoomIn')}
          title={t('view.zoomIn')}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => onZoomStep(1)}
        >
          <Icon name="plus" />
        </button>
        {/* The fit buttons are icons, as on the desktop; the name and tooltip carry the words. */}
        <button
          type="button"
          aria-label={t('view.fitWidth')}
          title={t('view.fitWidth')}
          aria-pressed={fit === 'width'}
          onClick={() => onZoom({ fit: 'width' })}
        >
          <Icon name="move-horizontal" />
        </button>
        <button
          type="button"
          aria-label={t('view.fitPage')}
          title={t('view.fitPage')}
          aria-pressed={fit === 'page'}
          onClick={() => onZoom({ fit: 'page' })}
        >
          <Icon name="expand" />
        </button>
      </div>
    </div>
  );
}
