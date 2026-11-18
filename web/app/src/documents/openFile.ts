// Opens one PDF through session.open (W3.1, W1.2 section 12). The file's bytes are the call's one
// binary value. The engine refuses a file above the 1 GiB limit (webapi/limits.py), so the same
// size is checked here first and the user gets the message without a round trip.
import type { EngineClient } from '../engine/engineConnection';
import { RpcError } from '../rpc/client';
import type { OpenResult } from '../rpc/generated';

// The engine's FILE_REFUSE_BYTES (webapi/limits.py). Above this the open fails with FILE_TOO_LARGE.
export const MAX_FILE_BYTES = 1024 ** 3;

// Resolves with the password, or null when the user cancels the prompt.
export interface PasswordAsker {
  (name: string): Promise<string | null>;
}

export type OpenOutcome =
  | { readonly status: 'opened'; readonly result: OpenResult }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly error: RpcError };

// Every failure leaves as an RpcError, so the caller maps all of them the same way.
export function asRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RpcError('INTERNAL', `the file could not be opened: ${message}`);
}

// The bytes are read for each attempt. Sending a buffer transfers it to the worker, which leaves
// the main thread's copy detached, so a second attempt needs a fresh read.
async function send(
  client: EngineClient,
  file: File,
  password: string | null,
): Promise<OpenResult> {
  const data = await file.arrayBuffer();
  return client.call('session.open', { name: file.name, data, password });
}

function isPasswordRequired(error: unknown): boolean {
  return error instanceof RpcError && error.code === 'PASSWORD_REQUIRED';
}

// Opens the file. A PASSWORD_REQUIRED reply asks for the password once (askPassword resolves null
// when the user cancels) and calls again with it. The password is used for that call only: the
// engine keeps it for the open document, and nothing here stores it.
export async function openFile(
  client: EngineClient,
  file: File,
  askPassword: PasswordAsker,
): Promise<OpenOutcome> {
  if (file.size > MAX_FILE_BYTES) {
    const error = new RpcError('FILE_TOO_LARGE', 'the file is too large for the browser', {
      max_bytes: MAX_FILE_BYTES,
      size: file.size,
    });
    return { status: 'failed', error };
  }

  try {
    return { status: 'opened', result: await send(client, file, null) };
  } catch (error) {
    if (!isPasswordRequired(error)) return { status: 'failed', error: asRpcError(error) };
  }

  const password = await askPassword(file.name);
  if (password === null) return { status: 'cancelled' };
  try {
    return { status: 'opened', result: await send(client, file, password) };
  } catch (error) {
    return { status: 'failed', error: asRpcError(error) };
  }
}
