// Insert from file (W6.1b slice 2): the file goes to the engine's pages.insert_file, which takes a
// PDF's pages or an image. An encrypted PDF asks for its password, at most PASSWORD_ATTEMPTS times
// (the engine's own limit). The bytes are read again for each call, because sending a buffer
// detaches it.
import type { PageRpc } from '../engine/engineConnection';
import { passwordPrompt, type PasswordPrompt } from '../documents/passwordRequest';
import { RpcError } from '../rpc/client';
import type { Methods } from '../rpc/generated';

// The same limit as the engine's password attempts (actions/pages.py _PASSWORD_ATTEMPTS).
export const PASSWORD_ATTEMPTS = 5;

export type InsertReply = Methods['actions.run']['result'];

// Thrown when the file is still locked after PASSWORD_ATTEMPTS answers. The panel shows a message.
export class PasswordGaveUp extends Error {
  constructor() {
    super('the file is still locked');
    this.name = 'PasswordGaveUp';
  }
}

export interface InsertFileDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly file: File;
  // The zero-based index the pages go in front of (the engine's pages.insert_file "at").
  readonly at: number;
  readonly prompt?: PasswordPrompt;
}

// Resolves with the engine's reply, or null when the user cancelled the password dialog. A wrong
// password asks again, until the attempts run out.
export async function insertFile(deps: InsertFileDeps): Promise<InsertReply | null> {
  const { rpc, handle, file, at } = deps;
  const prompt = deps.prompt ?? passwordPrompt;
  let password: string | null = null;
  let prompts = 0;
  for (;;) {
    try {
      return await rpc.call('actions.run', {
        handle,
        name: 'pages.insert_file',
        args: { data: await file.arrayBuffer(), name: file.name, at, pages: null, password },
      });
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== 'PASSWORD_REQUIRED') throw error;
      if (prompts >= PASSWORD_ATTEMPTS) throw new PasswordGaveUp();
      prompts += 1;
      const answer = await prompt.ask(file.name);
      if (answer === null) return null;
      password = answer;
    }
  }
}

// The number of pages the engine inserted (its value for insert_file), or 0 when it sent none.
export function insertedCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}
