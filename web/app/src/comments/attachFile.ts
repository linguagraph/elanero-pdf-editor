// The file an Attach File comment embeds (issue 732): the browser's picker, then the size check, before
// the file is read. The engine checks the same cap and refuses an empty file or an unusable name;
// this copy only spares the read of a file it would refuse for size.
import { MAX_ATTACHMENT_BYTES } from '../attachments/attachmentActions';
import { pickFile } from '../files/pickFile';
import { type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';

const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024);

// Asks for one file. Resolves with the file, or null when the user cancelled or the file is over
// the cap (the refusal is shown here). The picker opens from the click that calls this, so the call
// must come straight from that click, before any await.
export async function chooseAttachment(store: ToastStore = toasts): Promise<File | null> {
  const file = await pickFile('');
  if (file === null) return null;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    store.push('error', t('attachments.tooLarge', { mb: MAX_ATTACHMENT_MB }));
    return null;
  }
  return file;
}
