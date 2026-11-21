// The print job's call to the job worker (W1.2 section 13, W3.7, W6.5): job.run with print_pages.
// Each page arrives as a partial notice, in print order, as soon as the job has rendered it; the
// reply then carries the page count, which must match the pages received (a dropped notice must
// not print a short document). Progress notices feed the job bar.
import { progressPercent } from '../feedback/jobRun';
import type { Notice } from '../engine/loader';
import { RpcError, type RpcErrorCode } from '../rpc/client';
import { PROTOCOL_VERSION } from '../rpc/generated';
import type { WorkerClient } from '../engine/start';
import { t } from '../i18n/t';
import type { PrintFile } from './printPages';

export type PrintJobArgs = {
  readonly pages?: readonly number[];
  readonly dpi: number;
  readonly annotations: boolean;
};

function fail(message: string): never {
  throw new RpcError('INTERNAL', `the print job replied badly: ${message}`);
}

function objectOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${path} is not an object`);
  return value as Record<string, unknown>;
}

// One partial notice's page: its index must be the count so far (the order check), and its PNG
// bytes are the notice's own buffer.
function partialPage(notice: Notice, buffer: ArrayBuffer | undefined, count: number): PrintFile {
  const data = objectOf(notice.data, 'partial.data');
  if (data.index !== count) fail(`page ${String(data.index)} arrived out of order`);
  if (typeof data.name !== 'string' || data.mime !== 'image/png') fail('a page is not a PNG');
  if (buffer === undefined) fail(`page ${data.name} has no bytes`);
  return { name: data.name, mime: 'image/png', data: buffer };
}

// Runs print_pages on the job worker and returns the page files, in print order. Errors from the
// job come back as RpcError with the job's own code. onProgress gets each percent of the job.
export async function runPrintWorker(
  worker: WorkerClient,
  args: PrintJobArgs,
  document: ArrayBuffer,
  onProgress: (percent: number) => void = () => undefined,
): Promise<readonly PrintFile[]> {
  const pages: PrintFile[] = [];
  let failure: unknown;
  const request = JSON.stringify({
    v: PROTOCOL_VERSION,
    id: 1,
    method: 'job.run',
    params: { job: 'print_pages', args, document: { $bin: 0 } },
  });
  const result = await worker.call(request, [document], (notice, buffer) => {
    const percent = progressPercent(notice);
    if (percent !== undefined) onProgress(percent);
    if (notice.notice !== 'partial' || failure !== undefined) return;
    try {
      pages.push(partialPage(notice, buffer, pages.length));
    } catch (error) {
      failure = error;
    }
  });
  if (failure !== undefined) throw failure;
  const reply = objectOf(JSON.parse(result.reply) as unknown, 'reply');
  if (reply.ok !== true) {
    const error = objectOf(reply.error, 'reply.error');
    throw new RpcError(
      (typeof error.code === 'string' ? error.code : 'INTERNAL') as RpcErrorCode,
      typeof error.message === 'string' ? error.message : 'the print job failed',
      objectOf(error.details ?? {}, 'reply.error.details'),
    );
  }
  const body = objectOf(reply.result, 'reply.result');
  if (body.kind !== 'files' || !Array.isArray(body.files)) fail('the result is not a file list');
  // A page that came in the reply rather than as a partial is read by its $bin marker (W1.2
  // section 5), so every buffer of the reply is reachable, not just the first.
  const buffers = result.buffers ?? (result.buffer === undefined ? [] : [result.buffer]);
  for (const entry of body.files) {
    const file = objectOf(entry, 'file');
    const data = objectOf(file.data, 'file.data');
    const buffer = typeof data.$bin === 'number' ? buffers[data.$bin] : undefined;
    if (buffer === undefined) fail(`page ${String(file.name)} is not in the reply`);
    pages.push({ name: String(file.name), mime: String(file.mime), data: buffer });
  }
  const value = objectOf(body.value, 'reply.result.value');
  if (value.pages !== pages.length) throw new RpcError('INTERNAL', t('print.mismatch'));
  return pages;
}
