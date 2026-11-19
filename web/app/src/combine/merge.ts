// The merge job's call (W3.7, W1.2 section 13): job.run with job "merge", no jobs.prepare, since
// merge has no document. The sources are $bin values in args, in order; the job worker answers with
// the merged bytes as a "new_document" result named "merged.pdf". The job worker is its own Pyodide
// worker, so this is not the typed engine client: the envelope is built here, by hand.
import { RpcError, type RpcErrorCode } from '../rpc/client';
import { ERROR_CODES, PROTOCOL_VERSION } from '../rpc/generated';
import type { WorkerClient } from '../engine/start';

export interface MergeSourceBytes {
  readonly name: string;
  readonly data: ArrayBuffer;
}

export interface MergeOutput {
  readonly name: string;
  readonly bytes: ArrayBuffer;
}

interface Envelope {
  readonly v?: unknown;
  readonly id?: unknown;
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function internal(message: string): RpcError {
  return new RpcError('INTERNAL', `the merge job's reply is not valid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reads a failed reply. A code the app does not know is INTERNAL, never a guess.
function failure(error: unknown): RpcError {
  if (!isRecord(error) || typeof error.message !== 'string')
    return internal('an error without a message');
  const details = isRecord(error.details) ? error.details : {};
  const code = ERROR_CODES.find((known) => known === error.code);
  return new RpcError((code ?? 'INTERNAL') as RpcErrorCode, error.message, details);
}

// Runs the merge on the given job worker. The buffers are transferred, so the caller must not reuse
// them. The worker is left running; the caller terminates it when the job is over.
export async function runMergeJob(
  worker: WorkerClient,
  sources: readonly MergeSourceBytes[],
): Promise<MergeOutput> {
  const buffers: ArrayBuffer[] = [];
  const args = {
    sources: sources.map((source) => {
      buffers.push(source.data);
      return { name: source.name, data: { $bin: buffers.length - 1 } };
    }),
    bookmarks: true,
  };
  const request = JSON.stringify({
    v: PROTOCOL_VERSION,
    id: 1,
    method: 'job.run',
    params: { job: 'merge', args },
  });

  const reply = await worker.call(request, buffers);
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.reply);
  } catch {
    throw internal('not JSON');
  }
  if (!isRecord(parsed)) throw internal('not an object');
  const envelope = parsed as Envelope;
  if (envelope.v !== PROTOCOL_VERSION) throw internal('a different protocol version');
  if (envelope.ok !== true) throw failure(envelope.error);

  const result = envelope.result;
  if (!isRecord(result) || result.kind !== 'new_document') throw internal('not a new document');
  const marker = result.document;
  if (!isRecord(marker) || marker.$bin !== 0 || reply.buffer === undefined) {
    throw internal('the document is missing its buffer');
  }
  const name = typeof result.name === 'string' && result.name !== '' ? result.name : 'merged.pdf';
  return { name, bytes: reply.buffer };
}
