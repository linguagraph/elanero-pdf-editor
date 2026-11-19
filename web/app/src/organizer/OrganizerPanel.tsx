// The page organizer side panel (W6.1, W1.4 section 9). It lists the pages as thumbnails, lets the
// user select some of them, and runs rotate, move and delete on the selection through actions.run.
// Each change is undoable: an info toast offers Undo, which calls actions.undo. The engine is the
// only source of the page order, so the list is read again from session.pages after every change.
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import type { PageRpc } from '../engine/engineConnection';
import { reportRpcError, toasts, type ToastStore, undoAction } from '../feedback/toasts';
import { RpcError } from '../rpc/client';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { Panel } from '../layout/Panel';
import { CachedCanvas } from '../view/pixels';
import { type PlannedRender, RenderScheduler } from '../view/renderScheduler';
import { thumbnailScaleMilli, type ThumbnailSize } from '../view/thumbnails';
import {
  canDelete,
  clampSelection,
  movedPages,
  moveTarget,
  NO_SELECTION,
  type PageSelection,
  selectPage,
} from './selection';
import './organizer.css';

// The first pages get the engine's attention before the rest, as the thumbnails panel does.
const VISIBLE_HEAD = 24;

export interface OrganizerPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly onClose: () => void;
  // Called after a change that moves, removes or turns pages, so the document view and the
  // thumbnails panel drop what they drew before.
  readonly onChanged?: () => void;
  // Where the Undo toasts and the errors go. The app's toast store unless a test passes its own.
  readonly toastStore?: ToastStore;
}

type PageChange = 'pages.rotate' | 'pages.move' | 'pages.delete';

export function OrganizerPanel({
  rpc,
  handle,
  onClose,
  onChanged,
  toastStore = toasts,
}: OrganizerPanelProps) {
  const [sizes, setSizes] = useState<readonly ThumbnailSize[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selection, setSelection] = useState<PageSelection>(NO_SELECTION);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A new scheduler after each change: the page indexes now mean other pages, so the cache of the
  // old one is left behind rather than drawn wrongly.
  const [scheduler, setScheduler] = useState(() => new RenderScheduler(rpc, handle));
  const [tick, setTick] = useState(0);

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
    onChanged?.();
  };

  const undoChange = async () => {
    setBusy(true);
    try {
      const reply = await rpc.call('actions.undo', { handle });
      if (reply.done) await reload();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  };

  // Runs one page action, refreshes the list and shows the Undo toast. When the engine reports
  // nothing to do (executed false, a move that changes no order), nothing is shown.
  const change = async (
    name: PageChange,
    args: Record<string, unknown>,
    message: string,
    nextSelection: (value: unknown) => PageSelection | undefined,
  ) => {
    setBusy(true);
    try {
      const reply = await rpc.call('actions.run', { handle, name, args });
      if (!reply.executed) return;
      await reload(nextSelection(reply.value));
      toastStore.push(
        'info',
        message,
        undoAction(() => void undoChange()),
      );
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const picked = selection.picked;
  const total = sizes?.length ?? 0;
  const hasSelection = picked.length > 0;
  const choose = (index: number, modifiers: { ctrl: boolean; shift: boolean }) => {
    setSelection((current) => selectPage(current, index, modifiers));
  };

  const rotate = (delta: number) => {
    const count = picked.length;
    void change(
      'pages.rotate',
      { pages: picked, delta },
      t('organizer.rotated', { count }),
      () => undefined,
    );
  };

  const moveSelected = (direction: 'up' | 'down') => {
    const before = moveTarget(direction, picked, total);
    if (before === null) return;
    const count = picked.length;
    void change(
      'pages.move',
      { pages: picked, before },
      t('organizer.moved', { count }),
      (value) => {
        const moved = movedPages(value);
        if (moved === null || moved.length === 0) return undefined;
        return { picked: moved, anchor: moved[0] ?? null };
      },
    );
  };

  const deleteSelected = () => {
    if (!canDelete(picked, total)) return;
    const count = picked.length;
    void change(
      'pages.delete',
      { pages: picked },
      t('organizer.deleted', { count }),
      () => NO_SELECTION,
    );
  };

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
            {t('organizer.selected', { count: picked.length, total })}
          </p>
          <div role="toolbar" aria-label={t('organizer.actions')} className="organizer-actions">
            <button type="button" disabled={!hasSelection || busy} onClick={() => rotate(270)}>
              {t('command.rotate-pages-left.label')}
            </button>
            <button type="button" disabled={!hasSelection || busy} onClick={() => rotate(90)}>
              {t('command.rotate-pages-right.label')}
            </button>
            <button type="button" disabled={!canUp} onClick={() => moveSelected('up')}>
              {t('organizer.moveUp')}
            </button>
            <button type="button" disabled={!canDown} onClick={() => moveSelected('down')}>
              {t('organizer.moveDown')}
            </button>
            <button
              type="button"
              disabled={!canDelete(picked, total) || busy}
              onClick={() => setConfirming(true)}
            >
              {t('command.delete-pages.label')}
            </button>
          </div>
          {keepOne ? (
            <p className="organizer-status" role="status">
              {t('organizer.keepOne')}
            </p>
          ) : null}
          <div
            role="listbox"
            aria-label={t('organizer.pages')}
            aria-multiselectable="true"
            className="organizer-grid"
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
                  className="organizer-item"
                  data-selected={selected ? 'true' : 'false'}
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
        <p>{t('organizer.deleteBody', { count: picked.length })}</p>
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
