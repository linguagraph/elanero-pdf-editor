// What a PDF link does when it is followed (W5.3). Pure, so the rules are tested without a DOM.
// The engine's kind is a plain string (generated.ts), so anything other than the kinds this build
// knows is treated as unsupported: a future kind can never fall through to an open.
import type { LinkDto } from '../rpc/generated';

// Why a link did nothing; the view shows the matching message in its live region.
export type LinkNotice = 'noTarget' | 'unsupported';

export type LinkAction =
  | { readonly action: 'goto'; readonly page: number; readonly top: number | null }
  | { readonly action: 'notice'; readonly notice: LinkNotice };

// The action for a link: a jump to a page of this document, or a notice. Web and mail links are not
// followed yet (the confirmation dialog is the next change), so they fall to "unsupported" too.
export function classifyLink(link: LinkDto): LinkAction {
  if (link.kind !== 'goto') return { action: 'notice', notice: 'unsupported' };
  if (link.page === null) return { action: 'notice', notice: 'noTarget' };
  return { action: 'goto', page: link.page, top: link.top };
}
