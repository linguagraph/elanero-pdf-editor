// The page organizer side panel (W6.1, W1.4 section 9). It lists the pages as thumbnails, lets the
// user select some of them, and runs rotate, move and delete on the selection through actions.run.
// Each change is undoable: an info toast offers Undo, which calls actions.undo. The engine is the
// only source of the page order, so the list is read again from session.pages after every change.
import { useEffect, useRef, useState } from 'react';
import { Button, Tooltip, TooltipTrigger } from 'react-aria-components';
import type { PageRpc } from '../engine/engineConnection';
import type { JobWorker } from '../files/fileJob';
import { FileJobCancelled } from '../files/fileJob';
import { downloadBytes } from '../files/downloads';
import { passwordPrompt, type PasswordPrompt } from '../documents/passwordRequest';
import { reportRpcError, toasts, type ToastStore } from '../feedback/toasts';
import { offerUndo } from '../feedback/undoToast';
import { RpcError } from '../rpc/client';
import { t, tp } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { Panel } from '../layout/Panel';
import { ACCEPT } from '../combine/sources';
import { Icon } from '../theme/Icon';
import type { IconName } from '../theme/icons.generated';
import { CachedCanvas } from '../view/pixels';
import { type PlannedRender, RenderScheduler } from '../view/renderScheduler';
import { thumbnailScaleMilli, type ThumbnailSize } from '../view/thumbnails';
import { extractName, runExtract } from './extract';
import { insertFile, insertedCount, PasswordGaveUp } from './insertFile';
import {
  clearOrganizer,
  hasQueuedOrganizerCommands,
  type OrganizerActions,
  publishOrganizer,
  runOrganizerAction,
  takeQueuedOrganizerCommands,
} from './organizerBridge';
import {
  canDelete,
  clampSelection,
  duplicatedPages,
  insertAt,
  insertedSelection,
  movedPages,
  moveTarget,
  NO_SELECTION,
  type PageSelection,
  selectPage,
} from './selection';
import { useReorderDrag } from './useReorderDrag';
import './organizer.css';

// The first pages get the engine's attention before the rest, as the thumbnails panel does.
const VISIBLE_HEAD = 24;
// How long the pointer rests on a toolbar button before its tooltip shows (as the ribbon's).
const TOOLTIP_DELAY_MS = 400;

interface OrganizerActionProps {
  readonly icon: IconName;
  // The button's name for screen readers, and its tooltip.
  readonly label: string;
  readonly isDisabled: boolean;
  readonly onPress: () => void;
}

// One icon button of the toolbar. The label is its accessible name (aria-label) and its tooltip.
function OrganizerAction({ icon, label, isDisabled, onPress }: OrganizerActionProps) {
  return (
    <TooltipTrigger delay={TOOLTIP_DELAY_MS}>
      <Button
        className="organizer-action"
        aria-label={label}
        isDisabled={isDisabled}
        onPress={onPress}
      >
        <Icon name={icon} size={20} />
      </Button>
      <Tooltip className="ribbon-tooltip">{label}</Tooltip>
    </TooltipTrigger>
  );
}

export interface OrganizerPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly onClose: () => void;
  // Called after a change that moves, adds, removes or turns pages, with the new page count, so
  // the document view, the thumbnails panel and the tab's page count drop what they had before.
  readonly onChanged?: (pageCount: number) => void;
  // Where the Undo toasts and the errors go. The app's toast store unless a test passes its own.
  readonly toastStore?: ToastStore;
  // The open document's name, which the extract's download is named after.
  readonly documentName: string;
  // A new job worker for an extract. The app starts the built job worker.
  readonly startWorker: () => JobWorker;
  // Offers the extracted bytes as a file. The default makes a download link.
  readonly download?: (name: string, bytes: ArrayBuffer) => void;
  // Asks for the password of an encrypted file to insert. The app's password dialog unless a test
  // passes its own.
  readonly prompt?: PasswordPrompt;
  // The page a ribbon command preselects when it opens the panel (0-based): the page the view shows.
  // The panel uses it only for a queued command, so a panel opened from the rail starts empty.
  readonly initialPage?: number;
}

type PageChange =
  'pages.rotate' | 'pages.move' | 'pages.delete' | 'pages.insert_blank' | 'pages.duplicate';

// A new document gets a new panel (the key is the handle), so its selection, its pages and its status on
// the ribbon start fresh: the old document's selection cannot be used against the new handle, and a
// ribbon command in the reload queues until the new pages are in.
export function OrganizerPanel(props: OrganizerPanelProps) {
  return <OrganizerPanelContent key={props.handle} {...props} />;
}

function OrganizerPanelContent({
  rpc,
  handle,
  onClose,
  onChanged,
  toastStore = toasts,
  documentName,
  startWorker,
  download = downloadBytes,
  prompt = passwordPrompt,
  initialPage,
}: OrganizerPanelProps) {
  const [sizes, setSizes] = useState<readonly ThumbnailSize[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selection, setSelection] = useState<PageSelection>(NO_SELECTION);
  const [busy, setBusy] = useState(false);
  // The ribbon's actions read busy from a ref too: two presses before a re-render must not both run.
  const busyRef = useRef(false);
  const setBusyNow = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };
  // Whether a queued ribbon command has already preselected the initial page for this document.
  const preselected = useRef(false);
  const [confirming, setConfirming] = useState(false);
  // A new scheduler after each change: the page indexes now mean other pages, so the cache of the
  // old one is left behind rather than drawn wrongly.
  const [scheduler, setScheduler] = useState(() => new RenderScheduler(rpc, handle));
  const [tick, setTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Adopts a fresh page list. A move passes the pages it placed, which become the selection.
  const adopt = (pages: readonly ThumbnailSize[], nextSelection?: PageSelection) => {
    setScheduler(new RenderScheduler(rpc, handle));
    setSizes(pages);
    setSelection((current) => clampSelection(nextSelection ?? current, pages.length));
  };

  useEffect(() => {
    let active = true;
    rpc
      .call('session.pages', { handle })
      .then((reply) => {
        if (!active) return;
        setScheduler(new RenderScheduler(rpc, handle));
        setSizes(reply.pages);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [rpc, handle]);

  useEffect(() => scheduler.subscribe(() => setTick((value) => value + 1)), [scheduler]);
  // A replaced or dropped scheduler leaves no thumbnail waiting in its queue.
  useEffect(() => () => scheduler.plan('thumb', []), [scheduler]);

  useEffect(() => {
    if (sizes === null) return;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const planned: PlannedRender[] = sizes.map((size, index) => ({
      page: index,
      scaleMilli: thumbnailScaleMilli(size, devicePixelRatio),
      visible: index < VISIBLE_HEAD,
      distance: index,
    }));
    scheduler.plan('thumb', planned);
  }, [sizes, scheduler, tick]);

  const reportFailure = (error: unknown) => {
    if (error instanceof RpcError) reportRpcError(toastStore, error);
    else toastStore.push('error', t('organizer.failed'));
  };

  // Reads the page list again after a change, or after an undo.
  const reload = async (nextSelection?: PageSelection) => {
    const reply = await rpc.call('session.pages', { handle });
    adopt(reply.pages, nextSelection);
    onChanged?.(reply.pages.length);
  };

  // The Undo offer for one step. It names that step's history, so a press after another change
  // is refused by the engine (the helper says so) instead of undoing the newer step.
  const offerChangeUndo = (message: string, history: number) =>
    offerUndo('info', message, {
      rpc,
      handle,
      history,
      onUndone: () => reload().catch(reportFailure),
      store: toastStore,
    });

  // Runs one page action, refreshes the list and shows the Undo toast. When the engine reports
  // nothing to do (executed false, a move that changes no order), nothing is shown.
  const change = async (
    name: PageChange,
    args: Record<string, unknown>,
    message: string,
    nextSelection: (value: unknown) => PageSelection | undefined,
  ) => {
    if (busyRef.current) return;
    setBusyNow(true);
    try {
      const reply = await rpc.call('actions.run', { handle, name, args });
      if (!reply.executed) return;
      await reload(nextSelection(reply.value));
      offerChangeUndo(message, reply.state.history);
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusyNow(false);
    }
  };

  const picked = selection.picked;
  const total = sizes?.length ?? 0;
  const hasSelection = picked.length > 0;
  const choose = (index: number, modifiers: { ctrl: boolean; shift: boolean }) => {
    setSelection((current) => selectPage(current, index, modifiers));
  };

  const rotate = (delta: number) => {
    if (!hasSelection || busyRef.current) return;
    const count = picked.length;
    void change(
      'pages.rotate',
      { pages: picked, delta },
      tp('organizer.rotated', count),
      () => undefined,
    );
  };

  // Moves pages in front of `before` (the original numbering, 0..total). The moved pages become the
  // selection, and the Undo toast offers one step back. Move up/down and a drag both end here.
  const moveTo = (pages: readonly number[], before: number) => {
    const count = pages.length;
    void change('pages.move', { pages, before }, tp('organizer.moved', count), (value) => {
      const moved = movedPages(value);
      if (moved === null || moved.length === 0) return undefined;
      return { picked: moved, anchor: moved[0] ?? null };
    });
  };

  const moveSelected = (direction: 'up' | 'down') => {
    const before = moveTarget(direction, picked, total);
    if (before === null) return;
    moveTo(picked, before);
  };

  // A drag that presses an unselected page takes just that page as the selection first.
  const reorder = useReorderDrag({
    gridRef,
    picked,
    total,
    disabled: busy,
    onPick: (page) => choose(page, { ctrl: false, shift: false }),
    onDrop: moveTo,
  });
  const drag = reorder.drag;

  // The blank page takes the size of the page before it, and becomes the selection.
  const insertBlank = () => {
    const at = insertAt(picked, total);
    void change('pages.insert_blank', { at }, tp('organizer.inserted', 1), () => ({
      picked: [at],
      anchor: at,
    }));
  };

  // The copies go right after the last chosen page, and they become the selection.
  const duplicateSelected = () => {
    if (!hasSelection || busyRef.current) return;
    const copies = duplicatedPages(picked);
    const count = picked.length;
    void change('pages.duplicate', { pages: picked }, tp('organizer.duplicated', count), () => ({
      picked: copies,
      anchor: copies[0] ?? null,
    }));
  };

  // Inserts the chosen file in front of the selection's end (or at the end), and selects the pages it
  // brought. The password dialog runs inside insertFile; a cancel there changes nothing.
  const insertFromFile = async (file: File) => {
    const at = insertAt(picked, total);
    setBusyNow(true);
    try {
      const reply = await insertFile({ rpc, handle, file, at, prompt });
      if (reply === null || !reply.executed) return;
      const count = insertedCount(reply.value);
      await reload(insertedSelection(at, count));
      offerChangeUndo(tp('organizer.inserted', count), reply.state.history);
    } catch (error) {
      if (error instanceof PasswordGaveUp) toastStore.push('error', t('organizer.passwordGaveUp'));
      else reportFailure(error);
    } finally {
      setBusyNow(false);
    }
  };

  // The chosen pages go to a new file, which is downloaded. Nothing in the document changes, so
  // there is no Undo.
  const extract = async () => {
    if (!hasSelection || busyRef.current) return;
    const name = extractName(documentName);
    const count = picked.length;
    setBusyNow(true);
    try {
      const file = await runExtract({ engine: rpc, startWorker }, handle, picked);
      download(name, file.data);
      toastStore.push('info', tp('organizer.extracted', count, { name }));
    } catch (error) {
      if (!(error instanceof FileJobCancelled)) reportFailure(error);
    } finally {
      setBusyNow(false);
    }
  };

  const deleteSelected = () => {
    if (!canDelete(picked, total) || busyRef.current) return;
    const count = picked.length;
    void change(
      'pages.delete',
      { pages: picked },
      tp('organizer.deleted', count),
      () => NO_SELECTION,
    );
  };

  // The ribbon's view of this panel (issue 736). Each action is the closure a button above runs.
  const actions: OrganizerActions = {
    rotate: (delta) => rotate(delta),
    insertFile: () => {
      if (!busyRef.current) fileInput.current?.click();
    },
    duplicate: () => duplicateSelected(),
    extract: () => void extract(),
    askDelete: () => {
      if (!busyRef.current && canDelete(picked, total)) setConfirming(true);
    },
  };
  const ready = sizes !== null;
  // Publishes the selection to the ribbon's rules, and withdraws it when the panel goes. Commands the
  // ribbon queued (before the panel was ready, or while it loaded) run here, each once. A panel that a
  // ribbon command opened first preselects the initial page, and the commands run on the next render,
  // which holds that selection. Commands that arrive after this publish run at once from the bridge.
  // No dependency list on purpose: the bridge needs the actions of every render, and this effect
  // sets state only once (the preselect is guarded by a ref).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ready) return;
    publishOrganizer({ selected: picked.length, total, busy }, actions);
    if (!hasQueuedOrganizerCommands()) return;
    if (!preselected.current && picked.length === 0 && initialPage !== undefined && total > 0) {
      preselected.current = true;
      const index = Math.min(Math.max(initialPage, 0), total - 1);
      setSelection(selectPage(NO_SELECTION, index, { ctrl: false, shift: false }));
      return;
    }
    for (const id of takeQueuedOrganizerCommands()) {
      // A file chooser opens only from a press, and this runs from an effect, so the browser would
      // block it. The queued insert says what to press instead.
      if (id === 'insert-pages') {
        toastStore.push('info', t('organizer.insertFileHint'));
        continue;
      }
      runOrganizerAction(id, actions);
    }
  });
  useEffect(() => () => clearOrganizer(), []);

  if (loadFailed) {
    return (
      <Panel title={t('organizer.title')} onClose={onClose}>
        <p role="alert" className="organizer-status">
          {t('organizer.loadFailed')}
        </p>
      </Panel>
    );
  }

  const devicePixelRatio = window.devicePixelRatio || 1;
  const first = picked[0] ?? 0;
  const last = picked[picked.length - 1] ?? 0;
  const canUp = hasSelection && !busy && first > 0;
  const canDown = hasSelection && !busy && last < total - 1;
  const keepOne = total > 0 && picked.length === total;

  return (
    <Panel title={t('organizer.title')} onClose={onClose}>
      {sizes === null ? (
        <p role="status" className="organizer-status">
          {t('organizer.loading')}
        </p>
      ) : (
        <div className="organizer panel-fill">
          <p className="organizer-status" aria-live="polite">
            {drag !== null
              ? tp('organizer.dragging', drag.pages.length, {
                  position: drag.slot.before + 1,
                })
              : tp('organizer.selected', total, { selected: picked.length, total })}
          </p>
          <div role="toolbar" aria-label={t('organizer.actions')} className="organizer-actions">
            <OrganizerAction
              icon="rotate-ccw"
              label={t('command.rotate-pages-left.label')}
              isDisabled={!hasSelection || busy}
              onPress={() => rotate(270)}
            />
            <OrganizerAction
              icon="rotate-cw"
              label={t('command.rotate-pages-right.label')}
              isDisabled={!hasSelection || busy}
              onPress={() => rotate(90)}
            />
            <OrganizerAction
              icon="file"
              label={t('organizer.insertBlank')}
              isDisabled={busy}
              onPress={insertBlank}
            />
            <OrganizerAction
              icon="file-plus"
              label={t('organizer.insertFile')}
              isDisabled={busy}
              onPress={() => fileInput.current?.click()}
            />
            <OrganizerAction
              icon="copy"
              label={t('command.duplicate-pages.label')}
              isDisabled={!hasSelection || busy}
              onPress={duplicateSelected}
            />
            <OrganizerAction
              icon="file-output"
              label={t('command.extract-pages.label')}
              isDisabled={!hasSelection || busy}
              onPress={() => void extract()}
            />
            <OrganizerAction
              icon="chevron-up"
              label={t('organizer.moveUp')}
              isDisabled={!canUp}
              onPress={() => moveSelected('up')}
            />
            <OrganizerAction
              icon="chevron-down"
              label={t('organizer.moveDown')}
              isDisabled={!canDown}
              onPress={() => moveSelected('down')}
            />
            <OrganizerAction
              icon="file-x"
              label={t('command.delete-pages.label')}
              isDisabled={!canDelete(picked, total) || busy}
              onPress={() => setConfirming(true)}
            />
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            aria-label={t('organizer.insertFileLabel')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file !== undefined) void insertFromFile(file);
            }}
          />
          {keepOne ? (
            <p className="organizer-status" role="status">
              {t('organizer.keepOne')}
            </p>
          ) : null}
          <div
            ref={gridRef}
            role="listbox"
            aria-label={t('organizer.pages')}
            aria-description={t('organizer.dragHint')}
            aria-multiselectable="true"
            className="organizer-grid"
            tabIndex={0}
            data-dragging={drag !== null ? 'true' : undefined}
            {...reorder.gridHandlers}
          >
            {sizes.map((size, index) => {
              const selected = picked.includes(index);
              const cacheKey = scheduler.cacheKeyOf(
                'thumb',
                index,
                thumbnailScaleMilli(size, devicePixelRatio),
              );
              return (
                <div
                  key={index}
                  role="option"
                  aria-selected={selected}
                  aria-label={t('organizer.pageNumber', { page: index + 1, total })}
                  tabIndex={0}
                  draggable={false}
                  className="organizer-item"
                  data-page={index}
                  data-selected={selected ? 'true' : 'false'}
                  data-dragging={drag?.pages.includes(index) ? 'true' : undefined}
                  data-drop={drag?.slot.marker?.index === index ? drag.slot.marker.side : undefined}
                  onClick={(event) =>
                    choose(index, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey })
                  }
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    choose(index, { ctrl: false, shift: false });
                  }}
                >
                  <span className="organizer-thumb">
                    <CachedCanvas
                      cache={scheduler.cache}
                      cacheKey={cacheKey}
                      version={tick}
                      className="organizer-canvas"
                    />
                  </span>
                  <span className="organizer-number">{index + 1}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Overlay
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        title={t('organizer.deleteTitle')}
        showCloseButton={false}
      >
        <p>{tp('organizer.deleteBody', picked.length)}</p>
        <div className="organizer-confirm">
          <Button className="organizer-cancel" onPress={() => setConfirming(false)}>
            {t('organizer.cancel')}
          </Button>
          <Button
            className="organizer-danger"
            onPress={() => {
              setConfirming(false);
              deleteSelected();
            }}
          >
            {t('organizer.deleteConfirm')}
          </Button>
        </div>
      </Overlay>
    </Panel>
  );
}
