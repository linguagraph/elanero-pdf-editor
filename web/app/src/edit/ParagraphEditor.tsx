// The paragraph editor (W6.8a 8a-1, design section 2): a native textarea placed over one text block
// of the page, as the desktop's InlineTextEditor is. It shows the block's text, selected, in the
// document's own font when the browser can load it (previewFont.ts). Typing, IME, the clipboard and
// the textarea's undo are the browser's; nothing goes to the engine before a commit, and a commit is
// one actions.run (commit.ts). The layer that owns the editor passes the commit in as `onApply`.
// The style bar above the text (W6.8b slice 1) edits the style the commit sends with the text.
import {
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cssBox, pointsToCss } from '../comments/coordinates';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { PageObjectDto, TextStyleDto } from '../rpc/generated';
import type { ApplyText } from './applyText';
import { backgroundFrom, canScrollBy, readableColour } from './editorStyle';
import { documentNames, faceToggle, fontSections, isStandardName } from './fontList';
import { familyOf, previewFamilyCss } from './previewFont';
import { StyleBar } from './StyleBar';
import { openingStyle, styleChanged, type TextStyleArg, toActionStyle } from './textStyle';

// The smallest box the editor opens with, in CSS pixels (design section 2: at least 120 by 40).
const MIN_WIDTH_PX = 120;
const MIN_HEIGHT_PX = 40;
// The style bar: its height about one row of controls, the gap to the text, and its least width.
const BAR_HEIGHT_PX = 36;
const BAR_GAP_PX = 4;
const BAR_MIN_WIDTH_PX = 360;

const NO_OBJECTS: readonly PageObjectDto[] = [];

// The style a commit sends with the text: the bar's style when it changed the opening one, else null
// (the engine then keeps the block's own style).
function styleToSend(opening: TextStyleDto, current: TextStyleArg): TextStyleArg | null {
  return styleChanged(opening, current) ? toActionStyle(current) : null;
}

export interface ParagraphEditorProps {
  readonly object: PageObjectDto;
  readonly page: number;
  readonly zoom: number;
  readonly rpc: PageRpc;
  readonly handle: string;
  // Commits the typed text and the style the bar changed (null when it did not). Resolves true when
  // the editor should close, false when the engine was busy and the editor stays open with its text.
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
  // The page's objects, from the Edit tool's list: the font picker's document fonts (fontList.ts).
  readonly pageObjects?: readonly PageObjectDto[];
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
  pageObjects = NO_OBJECTS,
}: ParagraphEditorProps) {
  const style = object.style;
  const ref = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [value, setValue] = useState(object.text);
  const [busy, setBusy] = useState(false);
  // What a Bold or Italic press the font can't take says, for a screen reader: the key does nothing,
  // and this status tells why (cleared by the next style change or keystroke).
  const [faceNote, setFaceNote] = useState<string | null>(null);
  const [family, setFamily] = useState<string>(() => familyOf(style?.font ?? ''));
  // The style the bar shows and the commit sends. `styleRef` is the same value, read by the keys,
  // blurs and unmount that run between renders. The opening style has no font ref (the block's
  // font is found by name), so a picked standard font is a change.
  const [current, setCurrent] = useState<TextStyleArg>(() => ({
    ...openingStyle(style),
    font_ref: null,
  }));
  const styleRef = useRef<TextStyleArg>(current);
  const openingStyleRef = useRef<TextStyleDto>(current);
  const font = current.font;
  const sections = useMemo(
    () => fontSections(pageObjects, style?.font ?? ''),
    [pageObjects, style?.font],
  );
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
  const size = current.size;
  const lineHeightPt = size * current.line_height;
  // Above the text when there is room, else below it.
  const barTop =
    box.top >= BAR_HEIGHT_PX + BAR_GAP_PX
      ? box.top - BAR_HEIGHT_PX - BAR_GAP_PX
      : box.top + MIN_HEIGHT_PX + BAR_GAP_PX;

  // The opening text is selected, ready to be replaced.
  useEffect(() => {
    const el = ref.current;
    if (el !== null) {
      el.focus();
      el.select();
    }
  }, []);

  // The document's own face, once the browser has it; until then the generic family. A standard
  // font has no document face to ask for: its generic family is shown at once.
  const standardPick = current.font_ref?.kind === 'standard';
  useEffect(() => {
    if (standardPick) return undefined;
    let active = true;
    previewFamilyCss(rpc, handle, page, font)
      .then((css) => {
        if (active) setFamily(css);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [rpc, handle, page, font, standardPick]);
  const previewFamily = standardPick ? familyOf(font) : family;

  // The box grows with its text up to the page's bottom edge, then scrolls. The offset parent is the
  // page's edit layer, whose height is the page's.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    const parent = el.offsetParent;
    const room = parent instanceof HTMLElement ? parent.clientHeight - box.top : Infinity;
    el.style.height = `${Math.max(MIN_HEIGHT_PX, Math.min(el.scrollHeight, room))}px`;
  }, [value, zoom, box.top, size, current.line_height]);

  const close = () => {
    closed.current = true;
    onClose();
  };

  const setStyle = (next: TextStyleArg) => {
    styleRef.current = next;
    setFaceNote(null);
    setCurrent(next);
  };

  // Commits the text and the style (or closes, for null and for an unchanged text and style). The
  // editor stays open while the engine works, and on a busy reply.
  const end = async (text: string | null) => {
    if (closed.current || inFlight.current) return;
    const sent = styleToSend(openingStyleRef.current, styleRef.current);
    if (text === null || (text === openingRef.current && sent === null)) {
      close();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const done = await applyRef.current(text, sent);
    inFlight.current = false;
    if (done) close();
    else setBusy(false);
  };

  // An unmount without a close either commits what was typed and styled (a tool or tab switch,
  // desktop parity) or drops it (a page scrolled out of the mounted range, or a closed tab). A drop
  // sends nothing to the engine; the owner is told the text so it can be copied. Only the unmount
  // matters: the cleanup reads the latest text, style and the owner's answer through the refs.
  useEffect(
    () => () => {
      if (closed.current || inFlight.current) return;
      const sent = styleToSend(openingStyleRef.current, styleRef.current);
      const textChanged = valueRef.current !== openingRef.current;
      if (!textChanged && sent === null) return;
      const { commitOnLeave: commits = () => true, onDrop: drop } = leaveRef.current;
      if (commits()) void applyRef.current(valueRef.current, sent);
      else if (textChanged) drop?.(valueRef.current);
    },
    [],
  );

  // Alt+F10 moves to the style bar's first control (the ARIA practice for "go to the toolbar").
  const focusBar = () => {
    const first = barRef.current?.querySelector('[data-stop]');
    if (first instanceof HTMLElement) first.focus();
  };

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
    } else if (event.key === 'F10' && event.altKey) {
      event.preventDefault();
      focusBar();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[bi]$/i.test(event.key)) {
      // Bold and italic toggle from the keyboard too (the bar's buttons are the other way in). A
      // press the font can't take does nothing, as the disabled button.
      event.preventDefault();
      const which = event.key.toLowerCase() === 'b' ? 'bold' : 'italic';
      const change = faceToggle(styleRef.current, which, documentNames(sections));
      if (change !== null) setStyle({ ...styleRef.current, ...change });
      else setFaceNote(t(which === 'bold' ? 'edit.style.noBold' : 'edit.style.noItalic'));
    }
  };

  // A blur to another element of the app commits. A blur because the window lost focus does not:
  // switching applications must not apply half-typed text. A focus move into the style bar stays in
  // the editor.
  const onBlur = (event: { relatedTarget: EventTarget | null }) => {
    if (event.relatedTarget instanceof Node && barRef.current?.contains(event.relatedTarget))
      return;
    if (document.hasFocus()) void end(valueRef.current);
  };

  // The style bar's blur: a focus move to the text stays in the editor, anything else is a leave.
  const onBarLeave = (next: EventTarget | null) => {
    if (next === ref.current) return;
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
  const color = readableColour(current.color, background);
  const ownFace = current.font_ref === null && !isStandardName(font);

  return (
    <>
      <StyleBar
        rootRef={barRef}
        style={{
          left: box.left,
          top: barTop,
          minWidth: BAR_MIN_WIDTH_PX,
        }}
        value={current}
        fonts={sections}
        onChange={setStyle}
        onCommit={() => void end(valueRef.current)}
        onEscape={() => ref.current?.focus()}
        onLeave={onBarLeave}
      />
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
          fontFamily: previewFamily,
          fontSize: `${pointsToCss(size, zoom)}px`,
          lineHeight: current.line_height,
          color,
          // A document font previews its own face: the browser must not make it bold or slanted.
          fontWeight: ownFace ? 'normal' : current.bold ? 700 : 400,
          fontStyle: ownFace ? 'normal' : current.italic ? 'italic' : 'normal',
          textAlign: current.align,
          letterSpacing: `${pointsToCss(current.char_spacing, zoom)}px`,
          wordSpacing: `${pointsToCss(current.word_spacing, zoom)}px`,
        }}
        onChange={(event) => {
          valueRef.current = event.target.value;
          setFaceNote(null);
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
      <span role="status" className="visually-hidden">
        {faceNote}
      </span>
    </>
  );
}
