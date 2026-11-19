// The print job's call to the job worker (W1.2 section 13, W3.7): job.run with print_pages. The
// reply is the job's result: kind "files" carries one PNG per page. The job sends progress
// notices only, so the pages all arrive in this one reply.
import { RpcError, type RpcErrorCode } from '../rpc/client';
import { PROTOCOL_VERSION } from '../rpc/generated';
import type { WorkerClient } from '../engine/start';
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

// Runs print_pages on the job worker and returns the page files. Errors from the job come back as
// RpcError with the job's own code.
export async function runPrintWorker(
  worker: WorkerClient,
  args: PrintJobArgs,
  document: ArrayBuffer,
): Promise<readonly PrintFile[]> {
  const request = JSON.stringify({
    v: PROTOCOL_VERSION,
    id: 1,
    method: 'job.run',
    params: { job: 'print_pages', args, document: { $bin: 0 } },
  });
  const result = await worker.call(request, document);
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
  return body.files.map((entry: unknown) => {
    const file = objectOf(entry, 'file');
    const data = objectOf(file.data, 'file.data');
    // One binary value per reply (W1.2 section 5): every page must share the single buffer.
    if (data.$bin !== 0 || result.buffer === undefined)
      fail('a page image is not in the reply; only one binary value can cross');
    return {
      name: String(file.name),
      mime: String(file.mime),
      data: result.buffer,
    };
  });
}
