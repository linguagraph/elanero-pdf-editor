import type { KeyboardEvent, ReactNode } from 'react';
import { t, tp } from '../i18n/t';
import { PANEL_SIDE, type PanelKey, togglePanel, useOpenPanel } from './sidePanels';

export interface RailButtonProps {
  readonly panel: PanelKey;
  // The translated panel name: the tooltip, and the name before the count is added.
  readonly label: string;
  // An icon with aria-hidden set on its svg.
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  // The id of the element that shows this button's panel. Pass it only while that element is
  // mounted: aria-controls names it only while the button is expanded, so it never points at a
  // missing element.
  readonly controlsId?: string;
  // Shown as a badge when above zero (the search hits, for one). Above 99 the badge reads "99+".
  // The accessible name then gets the count too: "Search, 1 item".
  readonly count?: number;
}

// A rail button: it opens or closes its panel on the side the panel docks on. Up and Down move
// focus between the enabled buttons of the same rail, and wrap.
export function RailButton({
  panel,
  label,
  icon,
  disabled = false,
  controlsId,
  count = 0,
}: RailButtonProps) {
  const side = PANEL_SIDE[panel];
  const openOnSide = useOpenPanel(side);
  // A disabled button has no panel on screen (the side may still remember it open), so it is not
  // expanded either.
  const expanded = !disabled && openOnSide === panel;
  const name = count > 0 ? tp('rail.count', count, { panel: label }) : label;
  return (
    <button
      type="button"
      className="rail-button"
      data-panel={panel}
      title={name}
      aria-expanded={expanded}
      aria-controls={expanded && controlsId !== undefined ? controlsId : undefined}
      disabled={disabled}
      onClick={() => togglePanel(panel)}
      onKeyDown={moveAlongRail}
    >
      {icon}
      {count > 0 ? (
        <span className="rail-badge" aria-hidden="true">
          {count > 99 ? t('rail.badgeOverflow') : String(count)}
        </span>
      ) : null}
      <span className="visually-hidden">{name}</span>
    </button>
  );
}

function moveAlongRail(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [
    ...(event.currentTarget
      .closest('[role="toolbar"]')
      ?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  const index = buttons.indexOf(event.currentTarget);
  if (index < 0) return;
  event.preventDefault();
  const step = event.key === 'ArrowDown' ? 1 : -1;
  buttons[(index + step + buttons.length) % buttons.length]?.focus();
}
