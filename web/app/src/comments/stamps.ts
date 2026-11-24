// The standard stamps (W7.3 S6): the names the engine lists (STANDARD_STAMPS in the model), in the
// same order, and the label each shows. A stamp is placed by its name; the label is for the menu.
import type { MessageId } from '../i18n/en';
import type { CommentToolId } from './tools';

export const STANDARD_STAMPS = [
  'Approved',
  'AsIs',
  'Confidential',
  'Departmental',
  'Experimental',
  'Expired',
  'Final',
  'ForComment',
  'ForPublicRelease',
  'NotApproved',
  'NotForPublicRelease',
  'Sold',
  'TopSecret',
  'Draft',
] as const;

export type StandardStamp = (typeof STANDARD_STAMPS)[number];

// A custom image stamp the user kept (W7.3b S2): its library id and its label (the file name).
export interface CustomStampRef {
  readonly id: string;
  readonly label: string;
}

// The stamp the stamp tool places: a standard one by name, or a custom one from the library.
export type ChosenStamp =
  | { readonly kind: 'standard'; readonly name: StandardStamp }
  | ({ readonly kind: 'custom' } & CustomStampRef);

export const DEFAULT_STAMP: ChosenStamp = { kind: 'standard', name: 'Approved' };

// What the stamp state becomes when a custom stamp is removed (W7.3b S2). When the removed stamp was
// the chosen one, the stamp falls back to Approved, and the stamp tool turns off if it was on.
// The tool is returned as null only when it was the stamp tool; any other tool stays as it was.
export function afterStampRemoved(
  chosen: ChosenStamp,
  tool: CommentToolId | null,
  removedId: string,
): { readonly stamp: ChosenStamp; readonly tool: CommentToolId | null } {
  if (chosen.kind !== 'custom' || chosen.id !== removedId) return { stamp: chosen, tool };
  return { stamp: DEFAULT_STAMP, tool: tool === 'stamp' ? null : tool };
}

export const STAMP_LABEL: Readonly<Record<StandardStamp, MessageId>> = {
  Approved: 'stamp.name.Approved',
  AsIs: 'stamp.name.AsIs',
  Confidential: 'stamp.name.Confidential',
  Departmental: 'stamp.name.Departmental',
  Experimental: 'stamp.name.Experimental',
  Expired: 'stamp.name.Expired',
  Final: 'stamp.name.Final',
  ForComment: 'stamp.name.ForComment',
  ForPublicRelease: 'stamp.name.ForPublicRelease',
  NotApproved: 'stamp.name.NotApproved',
  NotForPublicRelease: 'stamp.name.NotForPublicRelease',
  Sold: 'stamp.name.Sold',
  TopSecret: 'stamp.name.TopSecret',
  Draft: 'stamp.name.Draft',
};
