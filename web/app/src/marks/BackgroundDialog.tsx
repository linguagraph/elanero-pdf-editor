// The background dialog (W7.3, design section 5.2): a colour and its opacity behind the page
// content, on the chosen pages. The shared shell (MarkDialog) reads the stored background when the
// document has one, runs the action and handles Replace, Add New and Remove.
import { useEffect, useId, useState } from 'react';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { BACKGROUND_ACTION, backgroundArgs, canRunBackground } from './marks';
import { type MarkDialogProps, MarkDialog, type MarkFormProps } from './MarkDialog';

// The desktop's default colour (1, 1, 0.9) and opacity (100 %).
const DEFAULT_COLOR = '#ffffe6';
const DEFAULT_OPACITY_PERCENT = 100;

export type BackgroundDialogProps = Omit<
  MarkDialogProps,
  'kind' | 'titleKey' | 'subtitleKey' | 'form'
>;

export function BackgroundDialog(props: BackgroundDialogProps) {
  return (
    <MarkDialog
      {...props}
      kind="Background"
      titleKey="marks.bg.title"
      subtitleKey="marks.bg.subtitle"
      form={BackgroundForm}
    />
  );
}

function BackgroundForm({ pre, pages, onDraft }: MarkFormProps) {
  const ids = useId();
  const stored = pre?.background;
  const [color, setColor] = useState(stored?.color ?? DEFAULT_COLOR);
  // The field holds percent, as the desktop shows it; the engine takes a fraction.
  const [percent, setPercent] = useState(
    String(Math.round((stored?.opacity ?? DEFAULT_OPACITY_PERCENT / 100) * 100)),
  );
  const opacity = Number(percent) / 100;

  const ready = canRunBackground(color, opacity, pages);
  const reason: MessageId | null = ready
    ? null
    : pages.length === 0
      ? 'marks.reason.noPages'
      : 'marks.reason.value';

  useEffect(() => {
    onDraft({
      action: BACKGROUND_ACTION,
      ready,
      reason,
      args: (target, replace) => backgroundArgs(color, opacity, target, replace),
    });
    return () => onDraft(null);
  }, [onDraft, ready, reason, color, opacity]);

  return (
    <div className="mark-fields">
      <label className="mark-field" htmlFor={`${ids}-color`}>
        <span>{t('marks.color')}</span>
        <input
          id={`${ids}-color`}
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
        />
      </label>
      <label className="mark-field" htmlFor={`${ids}-opacity`}>
        <span>{t('marks.opacity')}</span>
        <span className="mark-suffixed">
          <input
            id={`${ids}-opacity`}
            type="number"
            inputMode="numeric"
            min={5}
            max={100}
            step={1}
            value={percent}
            onChange={(event) => setPercent(event.target.value)}
          />
          <span>%</span>
        </span>
      </label>
    </div>
  );
}
