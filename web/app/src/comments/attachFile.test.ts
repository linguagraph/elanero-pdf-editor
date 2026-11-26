import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '../attachments/attachmentActions';
import { pickFile } from '../files/pickFile';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { chooseAttachment } from './attachFile';

vi.mock('../files/pickFile', () => ({ pickFile: vi.fn() }));

describe('choosing a file for an attachment (issue 732)', () => {
  const picked = vi.mocked(pickFile);

  beforeEach(() => {
    picked.mockReset();
  });

  it('refuses a file over the cap before reading it', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const slice = vi.fn();
    const big = { name: 'big.bin', size: MAX_ATTACHMENT_BYTES + 1, arrayBuffer, slice };
    picked.mockResolvedValue(big as unknown as File);
    const store = createToastStore();

    expect(await chooseAttachment(store)).toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
    expect(store.getState().visible[0]?.kind).toBe('error');
    expect(store.getState().visible[0]?.text).toBe(
      t('attachments.tooLarge', { mb: MAX_ATTACHMENT_BYTES / (1024 * 1024) }),
    );
  });

  it('returns a file at the cap, unread', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const ok = { name: 'ok.txt', size: MAX_ATTACHMENT_BYTES, arrayBuffer };
    picked.mockResolvedValue(ok as unknown as File);
    expect(await chooseAttachment(createToastStore())).toBe(ok);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('returns null, with nothing shown, when the user cancels', async () => {
    picked.mockResolvedValue(null);
    const store = createToastStore();
    expect(await chooseAttachment(store)).toBeNull();
    expect(store.getState().visible).toEqual([]);
  });
});
