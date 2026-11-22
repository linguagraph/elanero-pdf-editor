// The transparent text layer over one page (W5.4, W1.4 section 10). Each line is a positioned span
// in the page element, so the browser selects and copies the text natively. The spans are not hidden
// from assistive technology: a screen reader reads the page's text from them.
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { type TextLayerCache } from './textLayerCache';
import { placeLines, type TextLine } from './textLayer';
import { SelectionMarks } from './SelectionMarks';
import { handlePlacements, type HandleEnd, SelectionHandles } from './SelectionHandles';
import type { TextSelection } from './textSelection';
import './textLayer.css';

export interface PageTextLayerProps {
  readonly cache: TextLayerCache;
  readonly page: number;
  // The page revision the layer is asked for; a new revision asks the engine again.
  readonly revision: number;
  readonly zoom: number;
  // True while a gesture tool (a comment tool) is on: the layer then lets the pointer through to
  // the tool's layer beneath it and starts no text selection from a drag.
  readonly passive?: boolean;
  // The text selection the model holds, drawn over the page (W5.4 S3). Given (even null), the model
  // is in charge of the page's selection, so the browser's own selection stays off the spans.
  readonly selection?: TextSelection | null;
  // Whether the selection handles show: a touch or a pen was the last pointer (W5.4 S2). They are
  // drawn on the start and end pages only.
  readonly handles?: boolean;
  readonly onHandlePress?: (
    event: ReactPointerEvent<HTMLElement>,
    end: HandleEnd,
    grab: number,
  ) => void;
}

export function PageTextLayer({
  cache,
  page,
  revision,
  zoom,
  passive = false,
  selection,
  handles = false,
  onHandlePress,
}: PageTextLayerProps) {
  const [lines, setLines] = useState<readonly TextLine[]>([]);

  useEffect(() => {
    let active = true;
    cache.get(page, revision).then(
      (next) => {
        if (active) setLines(next);
      },
      () => {
        // No text for this page: the page image still shows, and nothing is selectable.
      },
    );
    return () => {
      active = false;
    };
  }, [cache, page, revision]);

  const placed = useMemo(() => placeLines(lines, zoom), [lines, zoom]);
  // The page's index arrives with its lines, so the marks are read once the lines are in state.
  const index = selection === undefined ? undefined : cache.readyIndex(page, revision);
  const placements =
    selection && handles && onHandlePress && !selection.isEmpty
      ? handlePlacements(selection, index, page, zoom)
      : [];
  const classes = ['page-text-layer'];
  if (passive) classes.push('page-text-layer--passive');
  if (selection !== undefined) classes.push('page-text-layer--model');
  // The handles hang below the line and past its ends, so the layer must not clip them (section 3).
  if (placements.length > 0) classes.push('page-text-layer--handles');
  return (
    <div className={classes.join(' ')}>
      {selection ? (
        <SelectionMarks selection={selection} index={index} page={page} zoom={zoom} />
      ) : null}
      {placed.map((line, index) => (
        <div
          // The lines of one page never reorder: the key is the line's position.
          key={index}
          data-line={index}
          className="page-text-line"
          style={{
            left: line.left,
            top: line.top,
            width: line.width,
            height: line.height,
            fontSize: line.height,
          }}
        >
          {line.text}
        </div>
      ))}
      {onHandlePress && placements.length > 0 ? (
        <SelectionHandles placements={placements} onPress={onHandlePress} />
      ) : null}
    </div>
  );
}
