// The comments panel's filters (W7.1b S2), ported from the desktop panel's _matches. A thread
// matches when its root and every reply match, so the filters never split a thread: a search or
// author that hits only a reply still shows the whole thread. The status is the thread's latest
// state (CommentThreadDto.status), not each reply's. The options are read from the list, and keep
// the current choice even when no thread has it now, so a reload never silently drops the filter.
import type { AnnotationType, CommentThreadDto, ReviewState } from '../../rpc/generated';

export interface CommentFilter {
  // Free text, matched case-insensitively against the text and the author of every comment.
  readonly search: string;
  readonly type: AnnotationType | null;
  readonly author: string | null;
  readonly status: ReviewState | null;
}

export const NO_FILTER: CommentFilter = { search: '', type: null, author: null, status: null };

export interface FilterOptions {
  readonly types: readonly AnnotationType[];
  readonly authors: readonly string[];
  readonly statuses: readonly ReviewState[];
}

// The order the panel lists the states in (the Review states of the PDF spec, as Acrobat shows them).
const STATUS_ORDER: readonly ReviewState[] = [
  'None',
  'Accepted',
  'Rejected',
  'Cancelled',
  'Completed',
];

export function threadMatches(thread: CommentThreadDto, filter: CommentFilter): boolean {
  if (filter.type !== null && thread.comment.type !== filter.type) return false;
  if (filter.status !== null && thread.status !== filter.status) return false;
  const comments = [thread.comment, ...thread.replies];
  if (filter.author !== null && !comments.some((c) => c.author === filter.author)) return false;
  const needle = filter.search.trim().toLowerCase();
  if (needle === '') return true;
  return comments.some(
    (c) => c.contents.toLowerCase().includes(needle) || c.author.toLowerCase().includes(needle),
  );
}

// The threads that pass the filter, in the list's order (the engine's page, then y, then x).
export function visibleThreads(
  threads: readonly CommentThreadDto[],
  filter: CommentFilter,
): CommentThreadDto[] {
  return threads.filter((thread) => threadMatches(thread, filter));
}

// The choices the filter selects offer: the values the list has, plus the current choice.
export function filterOptions(
  threads: readonly CommentThreadDto[],
  current: CommentFilter,
): FilterOptions {
  const types = new Set<AnnotationType>();
  const authors = new Set<string>();
  const statuses = new Set<ReviewState>();
  for (const thread of threads) {
    types.add(thread.comment.type);
    statuses.add(thread.status);
    for (const comment of [thread.comment, ...thread.replies]) {
      if (comment.author !== '') authors.add(comment.author);
    }
  }
  if (current.type !== null) types.add(current.type);
  if (current.status !== null) statuses.add(current.status);
  if (current.author !== null) authors.add(current.author);
  return {
    types: [...types].sort(),
    authors: [...authors].sort((a, b) => a.localeCompare(b)),
    statuses: STATUS_ORDER.filter((status) => statuses.has(status)),
  };
}
