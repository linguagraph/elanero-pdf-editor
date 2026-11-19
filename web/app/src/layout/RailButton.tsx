import type { KeyboardEvent, ReactNode } from 'react';
import { PANEL_SIDE, type PanelKey, togglePanel, useOpenPanel } from './sidePanels';

export interface RailButtonProps {
  readonly panel: PanelKey;
  // The translated panel name: the tooltip and the accessible name.
  readonly label: string;
  // An icon with aria-hidden set on its svg.
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  // The id of the element that shows this button's panel. Pass it only while that element is
  // mounted: aria-controls names it only while the button is expanded, so it never points at a
  // missing element.
  readonly controlsId?: string;
  // Replaces the default toggle. The app uses it to keep one panel open across both sides until
  // the left panels get their own slot (W4.2a S2).
  // TODO(W4.2a S2): remove the one-panel bridge once panels sit on their own side.
  readonly onToggle?: (panel: PanelKey) => void;
}

// A rail button: it opens or closes its panel on the side the panel docks on. Up and Down move
// focus between the enabled buttons of the same rail, and wrap.
export function RailButton({
  panel,
  label,
  icon,
  disabled = false,
  controlsId,
  onToggle,
}: RailButtonProps) {
  const side = PANEL_SIDE[panel];
  const expanded = useOpenPanel(side) === panel;
  return (
    <button
      type="button"
      className="rail-button"
      data-panel={panel}
      title={label}
      aria-expanded={expanded}
      aria-controls={expanded && controlsId !== undefined ? controlsId : undefined}
      disabled={disabled}
      onClick={() => {
        if (onToggle !== undefined) onToggle(panel);
        else togglePanel(panel);
      }}
      onKeyDown={moveAlongRail}
    >
      {icon}
      <span className="visually-hidden">{label}</span>
    </button>
  );
}

function moveAlongRail(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [
    ...(event.currentTarget
      .closest('.app-rail')
      ?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  const index = buttons.indexOf(event.currentTarget);
  if (index < 0) return;
  event.preventDefault();
  const step = event.key === 'ArrowDown' ? 1 : -1;
  buttons[(index + step + buttons.length) % buttons.length]?.focus();
}
