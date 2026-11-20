import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { DocInfo } from '../rpc/generated';
import { applyProperties, loadProperties, type PropertiesDeps } from './apply';
import { editableValues, MAX_FIELD_LENGTH } from './metadata';

const info: DocInfo = {
  encrypted: false,
  has_signatures: false,
  page_count: 3,
  title: 'Report',
  author: '',
  subject: '',
  keywords: '',
  creator: 'Writer',
  producer: 'PDF library',
  creation_date: '',
  mod_date: '',
  pdf_version: '1.7',
  is_tagged: false,
  has_forms: false,
  has_javascript: false,
  is_repaired: false,
  has_xmp: false,
};

function setup(executed = true) {
  const call = vi.fn(async (method: string) => {
    if (method === 'session.info') return info;
    if (method === 'actions.run') {
      return {
        label: 'Edit Document Properties',
        executed,
        value: null,
        changed: null,
        state: { history: 7 },
      };
    }
    return { done: true, label: 'Edit Document Properties', changed: null, state: { history: 7 } };
  });
  const store = createToastStore();
  const deps: PropertiesDeps = { rpc: { call } as unknown as PageRpc, handle: 'h1', store };
  return { call, store, deps };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('document properties', () => {
  it('reads the values with the existing session.info call', async () => {
    const { call, deps } = setup();
    expect(await loadProperties(deps)).toEqual(info);
    expect(call).toHaveBeenCalledWith('session.info', { handle: 'h1' });
  });

  it('runs document.set_metadata with the changed field and shows the Undo toast', async () => {
    const { call, store, deps } = setup();
    const edited = { ...editableValues(info), author: 'Finance' };
    const outcome = await applyProperties(deps, info, edited);
    expect(outcome).toEqual({ status: 'applied' });
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'document.set_metadata',
      args: {
        metadata: {
          title: 'Report',
          author: 'Finance',
          subject: '',
          keywords: '',
          creator: 'Writer',
          producer: 'PDF library',
          creation_date: '',
          mod_date: '',
        },
      },
    });
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('info');
    expect(toast?.text).toBe(t('properties.updated'));
    expect(toast?.action?.label).toBe(t('toast.undo'));
  });

  it('the Undo toast calls actions.undo', async () => {
    const { call, store, deps } = setup();
    await applyProperties(deps, info, { ...editableValues(info), title: 'New' });
    store.getState().visible[0]?.action?.run();
    await settle();
    expect(call).toHaveBeenLastCalledWith('actions.undo', { handle: 'h1', expect_history: 7 });
  });

  it('calls nothing when no field changed', async () => {
    const { call, deps } = setup();
    expect(await applyProperties(deps, info, editableValues(info))).toEqual({
      status: 'unchanged',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses an over-long field before any call', async () => {
    const { call, store, deps } = setup();
    const edited = { ...editableValues(info), title: 'x'.repeat(MAX_FIELD_LENGTH + 1) };
    expect(await applyProperties(deps, info, edited)).toEqual({ status: 'invalid' });
    expect(call).not.toHaveBeenCalled();
    expect(store.getState().visible).toEqual([]);
  });

  it('shows no toast when the engine changed nothing', async () => {
    const { store, deps } = setup(false);
    const outcome = await applyProperties(deps, info, { ...editableValues(info), author: 'A' });
    expect(outcome).toEqual({ status: 'unchanged' });
    expect(store.getState().visible).toEqual([]);
  });

  it('a stale Undo leaves the properties as they are and says so', async () => {
    const { call, store, deps } = setup();
    await applyProperties(deps, info, { ...editableValues(info), title: 'New' });
    call.mockRejectedValueOnce(new RpcError('STALE_OBJECT', 'changed', { history: 9 }));
    store.getState().visible[0]?.action?.run();
    await settle();
    expect(store.getState().visible.at(-1)?.text).toBe(t('toast.undo.stale'));
  });
});
