// Which of a tab's groups fit in the ribbon's row (W4.3a S3). The row's ref callback reads the
// widths while every group is rendered, and the count is derived from that during render. A group
// that is not in the row cannot be measured, so until every group of the tab has a width the
// ribbon shows them all; the measuring commit then settles before the browser paints.
import { useEffect, useState } from 'react';
import { getLocale } from '../i18n/t';
import { visibleGroupCount } from './overflow';

// The "More commands" button's CSS width (2.5rem at the 16 px root), which the overflow assumes.
const MORE_BUTTON_PX = 40;
const GROUP_ATTR = 'data-group';

export interface GroupOverflowOptions {
  // The selected tab, and its groups in order.
  readonly tab: string;
  readonly groupIds: readonly string[];
  // The ribbon form kind ('full' or 'compact'); the measured widths differ between them.
  readonly form: string;
  // False when the ribbon has no panels (the user collapsed it): every group then counts as shown.
  readonly enabled: boolean;
}

export interface GroupOverflow {
  // How many of the groups stay in the row, from the left. The rest go to the menu.
  readonly count: number;
  // The callback that measures the tab row (the element whose parent holds the selected tab's toolbar).
  readonly measureRow: (row: HTMLElement | null) => void;
}

interface Metrics {
  // The toolbar's content width, which the groups must fit in.
  readonly available: number;
  // The gap between toolbar items, which each group's width includes.
  readonly gap: number;
}

function readMetrics(row: HTMLElement): Metrics | null {
  const toolbar = row.parentElement?.querySelector<HTMLElement>('.ribbon-toolbar');
  if (toolbar === null || toolbar === undefined) return null;
  const style = getComputedStyle(toolbar);
  const padding = parsePx(style.paddingLeft) + parsePx(style.paddingRight);
  return { available: toolbar.clientWidth - padding, gap: parsePx(style.columnGap) };
}

function sameMetrics(a: Metrics | null, b: Metrics): boolean {
  return a !== null && a.available === b.available && a.gap === b.gap;
}

// The number of groups that stay in the row. The keys of the width cache carry the form and the
// language, so a change of either misses the cache and the groups are measured again.
export function useGroupOverflow({
  tab,
  groupIds,
  form,
  enabled,
}: GroupOverflowOptions): GroupOverflow {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
  const scope = `${form}|${getLocale()}|${tab}|`;

  // The row's width changes when the window does. Frames are coalesced, and sub-pixel changes are
  // ignored, so hiding a group cannot feed back into the observer.
  useEffect(() => {
    if (!enabled || row === null || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = readMetrics(row);
        if (next !== null) setMetrics((prev) => (sameMetrics(prev, next) ? prev : next));
      });
    });
    observer.observe(row);
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [row, enabled]);

  // Runs on every commit of the row, so it sees the groups that are rendered now. Each setter
  // returns its previous value when nothing changed, so a commit with no change ends the loop.
  const measureRow = (el: HTMLElement | null): void => {
    if (el === null) return;
    setRow(el);
    const next = readMetrics(el);
    if (next === null) return;
    setMetrics((prev) => (sameMetrics(prev, next) ? prev : next));
    const rendered = el.parentElement?.querySelectorAll<HTMLElement>(`[${GROUP_ATTR}]`) ?? [];
    const fresh: Record<string, number> = {};
    for (const node of rendered) {
      const id = node.getAttribute(GROUP_ATTR);
      if (id !== null) fresh[scope + id] = node.offsetWidth + next.gap;
    }
    setWidths((prev) => {
      const changed = Object.entries(fresh).some(([key, width]) => prev[key] !== width);
      return changed ? { ...prev, ...fresh } : prev;
    });
  };

  const measured = groupIds.map((id) => widths[scope + id]);
  const allMeasured = measured.every((width): width is number => width !== undefined);
  const count =
    enabled && metrics !== null && allMeasured
      ? visibleGroupCount(measured as number[], metrics.available, MORE_BUTTON_PX + metrics.gap)
      : groupIds.length;
  return { count, measureRow };
}

function parsePx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
