// Pointer handlers that pan a scroll container while the Hand tool is on (W4.10). Mouse and pen
// drag the content; a touch press is ignored, so one-finger touch keeps the browser's own native
// scrolling and momentum. The handlers are spread onto the scroll element, and they do nothing
// while `enabled` is false, so the Select tool keeps its pointer events.
import { type PointerEvent, useRef, useState } from 'react';
import { type PanStart, onScrollbar, panTo } from './pan';

interface Drag {
  readonly pointerId: number;
  readonly start: PanStart;
}

export interface HandPan {
  readonly panning: boolean;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
}

// `ratio` is the scroll pixels per drag pixel (1, unless the view uses the scaled scroll space).
export function useHandPan(enabled: boolean, ratio = 1): HandPan {
  const drag = useRef<Drag | null>(null);
  const [panning, setPanning] = useState(false);

  function endDrag(event: PointerEvent<HTMLElement>): void {
    const element = event.currentTarget;
    if (drag.current === null || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    setPanning(false);
  }

  return {
    panning: enabled && panning,
    onPointerDown(event) {
      if (!enabled || event.button !== 0 || event.pointerType === 'touch') return;
      const element = event.currentTarget;
      const rect = element.getBoundingClientRect();
      if (
        onScrollbar(rect, element.clientWidth, element.clientHeight, event.clientX, event.clientY)
      )
        return;
      // No native text selection or image drag while panning.
      event.preventDefault();
      // Focus without scrolling, so the arrow keys and PgUp / PgDn keep working on this element.
      element.focus({ preventScroll: true });
      element.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        start: {
          scrollLeft: element.scrollLeft,
          scrollTop: element.scrollTop,
          x: event.clientX,
          y: event.clientY,
        },
      };
      setPanning(true);
    },
    onPointerMove(event) {
      const current = drag.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      const element = event.currentTarget;
      const next = panTo(
        current.start,
        event.clientX,
        event.clientY,
        {
          maxLeft: element.scrollWidth - element.clientWidth,
          maxTop: element.scrollHeight - element.clientHeight,
        },
        ratio,
      );
      element.scrollLeft = next.left;
      element.scrollTop = next.top;
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  };
}
