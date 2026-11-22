// The paragraph editor (W6.8a 8a-1, design section 2): a native textarea placed over one text block
// of the page, as the desktop's InlineTextEditor is. It shows the block's text, selected, in the
// document's own font when the browser can load it (previewFont.ts). Typing, IME, the clipboard and
// the textarea's undo are the browser's; nothing goes to the engine before a commit, and a commit is
// one actions.run (commit.ts). The layer that owns the editor passes the commit in as `onApply`.
import {
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cssBox, pointsToCss } from '../comments/coordinates';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { PageObjectDto } from '../rpc/generated';
import type { ApplyText } from './applyText';
import { backgroundFrom, canScrollBy, readableColour } from './editorStyle';
import { familyOf, previewFamilyCss } from './previewFont';

// The smallest box the editor opens with, in CSS pixels (design section 2: at least 120 by 40).
const MIN_WIDTH_PX = 120;
const MIN_HEIGHT_PX = 40;

export interface ParagraphEditorProps {
  readonly object: PageObjectDto;
  readonly page: number;
  readonly zoom: number;
  readonly rpc: PageRpc;
  readonly handle: string;
  // Commits the typed text. Resolves true when the editor should close, false when the engine was
  // busy and the editor stays open with its text.
  readonly onApply: ApplyText;
  // Closes the editor with no further call (Escape, or after a commit that finished).
  readonly onClose: () => void;
  // Asked when the editor unmounts without a close: true commits the typed text (a tool switch or
  // a tab switch), false drops it (its page scrolled out of the mounted range, or its tab closed).
  // Absent, it commits.
  readonly commitOnLeave?: () => boolean;
  // Told the typed text of a dropped editor, when it differs from the opening text, so the owner
  // can offer it (Copy text). Nothing is sent to the engine for a drop.
  readonly onDrop?: (text: string) => void;
  // A new block (Add Text, W6.8a 8a-2) is labelled as one; the owner's commit adds it.
  readonly newBlock?: boolean;
}

export function ParagraphEditor({
  object,
  page,
  zoom,
  rpc,
  handle,
  onApply,
  onClose,
  commitOnLeave,
  onDrop,
  newBlock = false,
}: ParagraphEditorProps) {
  const style = object.style;
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const [value, setValue] = useState(object.text);
  const [busy, setBusy] = useState(false);
  const [family, setFamily] = useState<string>(() => familyOf(style?.font ?? ''));
  // Set once the editor has closed, or while a commit is in flight. A blur or an unmount after
  // either must not commit again.
  const closed = useRef(false);
  const inFlight = useRef(false);
  const valueRef = useRef(object.text);
  const openingRef = useRef(object.text);
  const applyRef = useRef(onApply);
  const leaveRef = useRef({ commitOnLeave, onDrop });
  useEffect(() => {
    applyRef.current = onApply;
    leaveRef.current = { commitOnLeave, onDrop };
  });

  const box = cssBox(object.bbox, zoom);
  const size = style?.size ?? 12;
  const lineHeightPt = size * (style?.line_height ?? 1.2);

  // The opening text is selected, ready to be replaced.
  useEffect(() => {
    const el = ref.current;
    if (el !== null) {
      el.focus();
      el.select();
    }
  }, []);

  // The document's own face, once the browser has it; until then the generic family.
  const font = style?.font ?? '';
  useEffect(() => {
    let active = true;
    previewFamilyCss(rpc, handle, page, font)
      .then((css) => {
        if (active) setFamily(css);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [rpc, handle, page, font]);

  // The box grows with its text up to the page's bottom edge, then scrolls. The offset parent is the
  // page's edit layer, whose height is the page's.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    const parent = el.offsetParent;
    const room = parent instanceof HTMLElement ? parent.clientHeight - box.top : Infinity;
    el.style.height = `${Math.max(MIN_HEIGHT_PX, Math.min(el.scrollHeight, room))}px`;
  }, [value, zoom, box.top]);

  const close = () => {
    closed.current = true;
    onClose();
  };

  // Commits `text` (or closes, for null and for an unchanged text). The editor stays open while the
  // engine works, and on a busy reply.
  const end = async (text: string | null) => {
    if (closed.current || inFlight.current) return;
    if (text === null || text === openingRef.current) {
      close();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const done = await applyRef.current(text);
    inFlight.current = false;
    if (done) close();
    else setBusy(false);
  };

  // An unmount without a close either commits what was typed (a tool or tab switch, desktop parity)
  // or drops it (a page scrolled out of the mounted range, or a closed tab). A drop sends nothing to
  // the engine; the owner is told the text so it can be copied. Only the unmount matters: the
  // cleanup reads the latest text and the owner's answer through the refs.
  useEffect(
    () => () => {
      if (closed.current || inFlight.current) return;
      if (valueRef.current === openingRef.current) return;
      const { commitOnLeave: commits = () => true, onDrop: drop } = leaveRef.current;
      if (commits()) void applyRef.current(valueRef.current);
      else drop?.(valueRef.current);
    },
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keys belong to the editor: the page's shortcuts (Delete, Undo) must not act on the objects.
    event.stopPropagation();
    // An IME candidate is confirmed or cancelled by these keys, which must not close the editor.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void end(null);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void end(valueRef.current);
    }
  };

  // A blur to another element of the app commits. A blur because the window lost focus does not:
  // switching applications must not apply half-typed text.
  const onBlur = () => {
    if (document.hasFocus()) void end(valueRef.current);
  };

  // The editor's pointer and double-click events stay here; the layer must not start a gesture.
  const stopPointer = (event: PointerEvent<HTMLTextAreaElement>) => event.stopPropagation();

  // A wheel the textarea can use scrolls it; otherwise, or with Ctrl held, it passes to the viewport.
  const onWheel = (event: WheelEvent<HTMLTextAreaElement>) => {
    if (event.ctrlKey) return;
    const el = event.currentTarget;
    if (canScrollBy(el.scrollTop, el.scrollHeight, el.clientHeight, event.deltaY)) {
      event.stopPropagation();
    }
  };

  const background = backgroundFrom(
    getComputedStyle(document.documentElement).getPropertyValue('--color-editor-bg'),
  );
  const color = style === null ? 'var(--color-text)' : readableColour(style.color, background);

  return (
    <>
      <textarea
        ref={ref}
        className="edit-editor"
        aria-label={t(newBlock ? 'edit.text.newLabel' : 'edit.text.editorLabel')}
        aria-describedby={hintId}
        aria-busy={busy}
        readOnly={busy}
        value={value}
        style={{
          left: box.left,
          top: box.top,
          width: Math.max(box.width, MIN_WIDTH_PX),
          minHeight: Math.max(MIN_HEIGHT_PX, pointsToCss(lineHeightPt, zoom)),
          fontFamily: family,
          fontSize: `${pointsToCss(size, zoom)}px`,
          lineHeight: style?.line_height ?? 1.2,
          color,
          fontWeight: style?.bold ? 700 : 400,
          fontStyle: style?.italic ? 'italic' : 'normal',
          textAlign: style?.align ?? 'left',
          letterSpacing: `${pointsToCss(style?.char_spacing ?? 0, zoom)}px`,
          wordSpacing: `${pointsToCss(style?.word_spacing ?? 0, zoom)}px`,
        }}
        onChange={(event) => {
          valueRef.current = event.target.value;
          setValue(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onPointerDown={stopPointer}
        onPointerMove={stopPointer}
        onPointerUp={stopPointer}
        onDoubleClick={stopPointer}
        onWheel={onWheel}
      />
      <span id={hintId} className="visually-hidden">
        {t('edit.text.hint')}
      </span>
    </>
  );
}
