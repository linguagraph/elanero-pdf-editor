// The comments of one page as focusable elements over their bounds (W7.1a slice 9), for screen
// readers and the keyboard. A page image says nothing, so each comment is a button labelled with its
// type, author and text. One tab stop per page (roving tabindex): Tab reaches the page's comments,
// Home and End or Ctrl+Up and Ctrl+Down step between them, and an arrow key moves the focused
// comment (Alt+arrow resizes it), each press one annotations.transform (keyboard.ts). Enter selects
// the comment (a note also opens its popup), and Delete is the Select tool's (DocumentView). The
// buttons take no pointer input: the mouse keeps the selection layer's own handling.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { t } from '../i18n/t';
import type { MessageId } from '../i18n/en';
import type { AnnotationType, PageCommentDto } from '../rpc/generated';
import { cssBox } from './coordinates';
import type { CommentRef } from './hitTest';
import { arrowStep } from './keyboard';

// The longest text a label reads out (characters); a longer note is cut, as the list's own preview.
export const LABEL_TEXT_CHARS = 80;

// The type names of the comments (the panel's own, for every type a comment may have).
const TYPE_LABEL: Readonly<Record<AnnotationType, MessageId>> = {
  Text: 'comment.type.Text',
  FreeText: 'comment.type.FreeText',
  Line: 'comment.type.Line',
  Square: 'comment.type.Square',
  Circle: 'comment.type.Circle',
  Polygon: 'comment.type.Polygon',
  PolyLine: 'comment.type.PolyLine',
  Highlight: 'comment.type.Highlight',
  Underline: 'comment.type.Underline',
  Squiggly: 'comment.type.Squiggly',
  StrikeOut: 'comment.type.StrikeOut',
  Stamp: 'comment.type.Stamp',
  Caret: 'comment.type.Caret',
  Ink: 'comment.type.Ink',
  Popup: 'comment.type.Popup',
  FileAttachment: 'comment.type.FileAttachment',
  Redact: 'comment.type.Redact',
  Link: 'comment.type.Link',
  Widget: 'comment.type.Widget',
  Other: 'comment.type.Other',
};

// The label a screen reader says for a comment: "Note by Ana: Check this", plus "locked".
export function commentLabel(c: PageCommentDto): string {
  const type = t(TYPE_LABEL[c.type]);
  const head = c.author === '' ? type : t('comment.list.by', { type, author: c.author });
  const text = c.contents.slice(0, LABEL_TEXT_CHARS);
  const named = text === '' ? head : t('comment.list.label', { name: head, text });
  return c.locked ? t('comment.list.locked', { label: named }) : named;
}

export interface PageCommentListProps {
  readonly page: number;
  // The page's visible comments, in the page's order.
  readonly comments: readonly PageCommentDto[];
  readonly zoom: number;
  // An arrow press on a comment: its step in page points, and whether Alt made it a resize.
  readonly onNudge: (comment: PageCommentDto, dx: number, dy: number, resize: boolean) => void;
  // An arrow key is released on a comment: the next press of it starts a new undo step.
  readonly onNudgeEnd: (comment: PageCommentDto) => void;
  // Enter or click on a comment: select it (a note also opens its popup).
  readonly onActivate: (ref: CommentRef, comment: PageCommentDto) => void;
  // The page's layer, focused when the last comment goes (Delete takes the list's focus with it).
  readonly pageLayer: RefObject<HTMLElement | null>;
}

export function PageCommentList({
  page,
  comments,
  zoom,
  onNudge,
  onNudgeEnd,
  onActivate,
  pageLayer,
}: PageCommentListProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // The comment that has focus, and its position: Delete removes it, and focus must go somewhere.
  const focused = useRef<{ name: string; index: number } | null>(null);
  const last = comments.length - 1;
  // The tab stop stays on a comment that still exists, when the list shrinks under it.
  const current = Math.min(focusIndex, Math.max(last, 0));

  // A focused comment that was removed (Delete) took the focus with it. The comment that takes its
  // place (the next one, or the previous one when it was last) gets the focus, or the page's layer
  // when none is left. Only when the focus fell to the body: a focus elsewhere is not taken.
  useEffect(() => {
    const was = focused.current;
    if (was === null || comments.some((c) => c.name === was.name)) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    focused.current = null;
    const index = Math.min(was.index, last);
    if (index < 0) {
      pageLayer.current?.focus();
      return;
    }
    buttons.current[index]?.focus();
  });

  const focusAt = (index: number) => {
    const next = Math.min(Math.max(index, 0), last);
    setFocusIndex(next);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const comment = comments[index];
    if (comment === undefined || event.nativeEvent.isComposing) return;
    const stepBy = (event.ctrlKey || event.metaKey) && !event.altKey;
    let target: number | null = null;
    if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = last;
    else if (stepBy && event.key === 'ArrowUp') target = index - 1;
    else if (stepBy && event.key === 'ArrowDown') target = index + 1;
    if (target !== null) {
      event.preventDefault();
      event.stopPropagation();
      focusAt(target);
      return;
    }
    const step = arrowStep(event.key, event.shiftKey);
    if (step !== null) {
      event.preventDefault();
      event.stopPropagation();
      onNudge(comment, step.dx, step.dy, event.altKey);
    }
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const comment = comments[index];
    if (comment !== undefined && arrowStep(event.key, event.shiftKey) !== null) {
      onNudgeEnd(comment);
    }
  };

  return (
    <div role="group" aria-label={t('comment.list.page', { page: page + 1 })}>
      {comments.map((c, i) => (
        <button
          key={c.name}
          type="button"
          ref={(el) => {
            buttons.current[i] = el;
          }}
          className="comment-list-item"
          style={cssBox(c.bounds, zoom)}
          tabIndex={i === current ? 0 : -1}
          aria-label={commentLabel(c)}
          onFocus={() => {
            setFocusIndex(i);
            focused.current = { name: c.name, index: i };
          }}
          onKeyDown={(event) => onKeyDown(event, i)}
          onKeyUp={(event) => onKeyUp(event, i)}
          onClick={() => onActivate({ page, name: c.name }, c)}
        />
      ))}
    </div>
  );
}
