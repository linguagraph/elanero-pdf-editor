// The standard stamps (W7.3 S6): the names the engine lists (STANDARD_STAMPS in the model), in the
// same order, and the label each shows. A stamp is placed by its name; the label is for the menu.
import type { MessageId } from '../i18n/en';

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
