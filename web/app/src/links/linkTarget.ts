// What a PDF link does when it is followed (W5.3). Pure, so the rules are tested without a DOM.
// The engine's kind is a plain string (generated.ts), so anything other than the kinds this build
// knows is treated as unsupported: a future kind can never fall through to an open.
import type { LinkDto } from '../rpc/generated';

// Why a link did nothing; the view shows the matching message in its live region.
export type LinkNotice = 'noTarget' | 'unsupported' | 'malformed' | 'blocked';

export type LinkAction =
  | { readonly action: 'goto'; readonly page: number; readonly top: number | null }
  // A web or mail link, allowed: the dialog shows the parsed host and the full href, and Open
  // opens exactly that href.
  | {
      readonly action: 'confirm';
      readonly href: string;
      readonly scheme: string;
      readonly host: string;
    }
  // `scheme` is set for a blocked link only: the scheme the link asked for, cut to 20 characters.
  | { readonly action: 'notice'; readonly notice: LinkNotice; readonly scheme?: string };

export type LinkConfirm = Extract<LinkAction, { readonly action: 'confirm' }>;

// The only schemes a PDF link may open (W1.7 §6). Checked on the parsed protocol, never the raw text.
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);
const MAX_SCHEME_LENGTH = 20;
// An http or https address needs an authority: "//" then a host, with no slash in between. The WHATWG
// parser would read "http:///x" as host "x", which is not what the document meant.
const WEB_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/\\?#]/i;

const malformed: LinkAction = { action: 'notice', notice: 'malformed' };

// Strips the leading and trailing ASCII whitespace and control characters, as the URL parser does.
function trimControls(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

// The action for a URI link. It parses without a base: a relative reference would resolve against
// the app's own origin, which is never what the document meant.
export function classifyUri(uri: string): LinkAction {
  const text = trimControls(uri);
  if (text === '') return malformed;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return malformed;
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      action: 'notice',
      notice: 'blocked',
      scheme: url.protocol.slice(0, -1).slice(0, MAX_SCHEME_LENGTH),
    };
  }
  // The parser drops tabs and newlines anywhere, so the authority is checked on the same text.
  const stripped = text.replace(/[\t\n\r]/g, '');
  if (url.protocol === 'mailto:') {
    if (url.pathname === '') return malformed;
  } else if (url.hostname === '' || !WEB_AUTHORITY.test(stripped)) {
    return malformed;
  }
  // Everything after this uses the serialized href: the host is punycoded and the rest is ASCII, so
  // the dialog shows exactly what Open navigates to.
  return { action: 'confirm', href: url.href, scheme: url.protocol, host: url.hostname };
}

// The action for a link: a jump to a page of this document, a web or mail link to confirm, or a
// notice. Any other kind is unsupported.
export function classifyLink(link: LinkDto): LinkAction {
  if (link.kind === 'uri') return classifyUri(link.uri);
  if (link.kind !== 'goto') return { action: 'notice', notice: 'unsupported' };
  if (link.page === null) return { action: 'notice', notice: 'noTarget' };
  return { action: 'goto', page: link.page, top: link.top };
}
