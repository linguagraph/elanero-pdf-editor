// The note popup (W7.1a slice 8, port of ui/view/note_popup.py): a non-modal popover beside a sticky
// note, with its author and date, its text, its replies and a one-line reply box. The text is saved
// when the popup closes (Close, Escape, a press outside it, or the note leaving the page), and only
// if it changed, through annotations.set_text. A reply is posted with annotations.reply on Enter.
// Document text is shown as text, never as HTML.
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { formatDate } from '../i18n/format';
import { t } from '../i18n/t';
import type { CommentDto, PageCommentDto } from '../rpc/generated';
import { type EditDeps, editText, replyTo } from './panel/edits';
import { NOT_PAGE_SELECTOR } from './pageGuard';
import './comments.css';

export interface NotePopupProps {
  // The note, and its replies (oldest first), as the page's thread list holds them.
  readonly comment: PageCommentDto;
  readonly replies: readonly CommentDto[];
  readonly deps: EditDeps;
  // The popup's place in the page's CSS pixels, beside the note's icon.
  readonly left: number;
  readonly top: number;
  // Called when the popup should close (Close, Escape, a press outside). The owner unmounts it,
  // and the unmount saves the text.
  readonly onClose: () => void;
  // The element that takes focus back when the popup closes with focus inside it (read at close).
  readonly returnFocusTo: RefObject<HTMLElement | null>;
  // Whether the note is still on the page, read at close: a note deleted meanwhile is not saved.
  readonly stillOnPage: () => boolean;
}

// The date shown in the header: the modified date, else the created one; empty when neither parses.
function headerDate(comment: PageCommentDto): string {
  const when = comment.modified ?? comment.created;
  if (when === null) return '';
  const date = new Date(when);
  return Number.isNaN(date.getTime()) ? '' : formatDate(date);
}

export function NotePopup({
  comment,
  replies,
  deps,
  left,
  top,
  onClose,
  returnFocusTo,
  stillOnPage,
}: NotePopupProps) {
  const [text, setText] = useState(comment.contents);
  // Set when the user types: an outside change (Undo, the panel) then reseeds the text, and a close
  // saves only what the user typed.
  const dirty = useRef(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const textId = useId();
  const replyId = useId();

  // The latest values the unmount reads: the effect below runs once, so it saves what was typed
  // last, not what was there when the popup opened.
  const latest = useRef({ text, comment, deps, onClose, stillOnPage });
  useEffect(() => {
    latest.current = { text, comment, deps, onClose, stillOnPage };
  });

  // The note's contents changed from outside (Undo, an edit in the panel) and the user has not typed:
  // the text shows the note's contents, so a later close does not write the old text back.
  useEffect(() => {
    if (!dirty.current) setText(comment.contents);
  }, [comment.contents]);

  // Focus goes into the text when the popup opens. A press outside closes it, and the unmount saves
  // the text (when it changed) and returns focus to the note's page, if focus was in the popup.
  useEffect(() => {
    const root = rootRef.current;
    // The page layer is the same element for the popup's whole life, so it is read once, here.
    const focusTarget = returnFocusTo.current;
    textRef.current?.focus();
    const onPress = (event: PointerEvent) => {
      const target = event.target;
      // A press in a menu, a dialog or a control over the page is theirs, not a page press.
      if (target instanceof Element && target.closest(NOT_PAGE_SELECTOR) !== null) return;
      if (root !== null && target instanceof Node && root.contains(target)) return;
      latest.current.onClose();
    };
    window.addEventListener('pointerdown', onPress, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', onPress, { capture: true });
      const { text: typed, comment: note, deps: edit } = latest.current;
      // A note deleted while the popup was open is not saved to: the owner says it is gone.
      if (
        dirty.current &&
        !note.locked &&
        typed !== note.contents &&
        latest.current.stillOnPage()
      ) {
        void editText(edit, note, typed);
      }
      const active = document.activeElement;
      if (
        focusTarget !== null &&
        (active === null || active === document.body || (root !== null && root.contains(active)))
      ) {
        focusTarget.focus({ preventScroll: true });
      }
    };
    // The popup is keyed by its note, so the effect runs once per note (returnFocusTo is stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const postReply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.trim() === '') return;
    void replyTo(deps, comment, draft).then((ok) => {
      if (ok) setDraft('');
    });
  };

  const when = headerDate(comment);
  return (
    <div
      ref={rootRef}
      className="comment-note-popup"
      role="dialog"
      aria-label={t('comment.type.Text')}
      style={{ left, top }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="comment-note-popup-header">
        <span className="comment-note-popup-author">
          {comment.author.trim() === '' ? t('comments.popup.unknownAuthor') : comment.author}
        </span>
        {when === '' ? null : <span className="comment-note-popup-date">{when}</span>}
      </div>
      <label htmlFor={textId}>{t('comments.edit.label')}</label>
      <textarea
        id={textId}
        ref={textRef}
        rows={4}
        value={text}
        readOnly={comment.locked}
        onChange={(event) => {
          dirty.current = true;
          setText(event.target.value);
        }}
      />
      {replies.length > 0 ? (
        <ul className="comment-note-popup-replies" aria-label={t('comments.replies')}>
          {replies.map((reply) => (
            <li key={reply.name}>
              <span className="comment-note-popup-author">
                {reply.author.trim() === '' ? t('comments.popup.unknownAuthor') : reply.author}
              </span>
              <span>{reply.contents}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="comment-note-popup-reply" onSubmit={postReply}>
        <label htmlFor={replyId}>{t('comments.reply.label')}</label>
        <input
          id={replyId}
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={draft.trim() === ''}>
          {t('comments.reply.post')}
        </button>
      </form>
      <div className="comment-note-popup-actions">
        <button type="button" onClick={onClose}>
          {t('comments.popup.close')}
        </button>
      </div>
    </div>
  );
}
