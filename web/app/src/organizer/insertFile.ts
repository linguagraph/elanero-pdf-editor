// Insert from file (W6.1b slice 2): the file goes to the engine's pages.insert_file, which takes a
// PDF's pages or an image. An encrypted PDF asks for its password, at most PASSWORD_ATTEMPTS times
// (documents/withPassword.ts). The bytes are read again for each call, because sending a buffer
// detaches it.
import type { PageRpc } from '../engine/engineConnection';
import { passwordPrompt, type PasswordPrompt } from '../documents/passwordRequest';
import { withPassword } from '../documents/withPassword';
import type { Methods } from '../rpc/generated';

export type InsertReply = Methods['actions.run']['result'];

export interface InsertFileDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly file: File;
  // The zero-based index the pages go in front of (the engine's pages.insert_file "at").
  readonly at: number;
  readonly prompt?: PasswordPrompt;
}

// Resolves with the engine's reply, or null when the user cancelled the password dialog.
export async function insertFile(deps: InsertFileDeps): Promise<InsertReply | null> {
  const { rpc, handle, file, at } = deps;
  const won = await withPassword(
    file.name,
    async (password) =>
      rpc.call('actions.run', {
        handle,
        name: 'pages.insert_file',
        args: { data: await file.arrayBuffer(), name: file.name, at, pages: null, password },
      }),
    deps.prompt ?? passwordPrompt,
  );
  return won === null ? null : won.value;
}

// The number of pages the engine inserted (its value for insert_file), or 0 when it sent none.
export function insertedCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}
