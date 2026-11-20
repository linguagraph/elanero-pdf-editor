import { type KeyboardEvent, type PointerEvent, useRef } from 'react';
import { t } from '../i18n/t';
import type { Side } from './sidePanels';

// The step of one arrow key press, in px (W1.6 section 12: a keyboard resize is a 16 px step).
export const RESIZE_STEP_PX = 16;

export interface PanelResizerProps {
  readonly side: Side;
  // The width the panel shows now (already clamped by the caller).
  readonly value: number;
  readonly min: number;
  readonly max: number;
  // Called on every move while dragging, so the panel follows the pointer.
  onChange(width: number): void;
  // Called once when a drag ends or a key press changes the width: the width is saved here.
  onCommit(width: number): void;
}

// The separator on the inner edge of a side panel (W1.6 section 4). Dragging it or pressing an arrow
// key changes the width. Right moves the separator right, as a drag does, so it widens the left
// panel and narrows the right one. Home and End go to the minimum and the maximum.
export function PanelResizer({ side, value, min, max, onChange, onCommit }: PanelResizerProps) {
  const direction = side === 'left' ? 1 : -1;
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const clamp = (width: number) => Math.min(max, Math.max(min, Math.round(width)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { startX: event.clientX, startWidth: value, last: value };
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    const width = clamp(current.startWidth + direction * (event.clientX - current.startX));
    if (width === current.last) return;
    current.last = width;
    onChange(width);
  };

  const endDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (current !== null && current.last !== current.startWidth) onCommit(current.last);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = value + direction * RESIZE_STEP_PX;
    else if (event.key === 'ArrowLeft') next = value - direction * RESIZE_STEP_PX;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    const width = clamp(next);
    if (width === value) return;
    onChange(width);
    onCommit(width);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={side === 'left' ? t('layout.resizeLeftPanel') : t('layout.resizeRightPanel')}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      className={`app-panel-resizer app-panel-resizer-${side}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
