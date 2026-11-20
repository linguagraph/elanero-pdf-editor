// Runs one crop through `actions.run` (W4.11 S3). The crop is one undo step: a crop that changed
// the document offers Undo in an info toast, and an Undo redraws the view as the crop did. A crop
// that found nothing to do (executed false) shows no toast.
import type { PageRpc } from '../engine/engineConnection';
import { toasts, type ToastStore } from '../feedback/toasts';
import { offerUndo } from '../feedback/undoToast';
import { tp } from '../i18n/t';
import type { ChangedDto, RunResult } from '../rpc/generated';
import type { CropArgs } from './cropChoice';

export interface CropDeps {
  readonly rpc: Pick<PageRpc, 'call'>;
  readonly handle: string;
  // Redraws the pages a crop (or its Undo) changed. The app passes the view's scheduler here.
  readonly onChanged?: (changed: ChangedDto | null) => void;
  readonly store?: ToastStore;
}

// Crops the chosen pages by the margins in `args`. Rejects with the RPC error when the engine
// refuses; the caller shows it.
export async function runCrop(deps: CropDeps, args: CropArgs): Promise<RunResult> {
  const { rpc, handle, onChanged, store = toasts } = deps;
  const reply = await rpc.call('actions.run', {
    handle,
    name: 'pages.crop_margins',
    args: {
      pages: args.pages,
      left: args.left,
      top: args.top,
      right: args.right,
      bottom: args.bottom,
    },
  });
  if (!reply.executed) return reply;
  onChanged?.(reply.changed);
  offerUndo('info', tp('crop.done', args.pages.length), {
    rpc,
    handle,
    history: reply.state.history,
    onUndone: (undone) => onChanged?.(undone.changed),
    store,
  });
  return reply;
}
