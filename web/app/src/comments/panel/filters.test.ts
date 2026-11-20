import { describe, expect, it } from 'vitest';
import type { AnnotationType, CommentDto, CommentThreadDto } from '../../rpc/generated';
import { filterOptions, NO_FILTER, threadMatches, visibleThreads } from './filters';

function comment(
  page: number,
  author: string,
  contents: string,
  type: AnnotationType = 'Text',
): CommentDto {
  return {
    page,
    name: `c${page}${author}`,
    type,
    author,
    contents,
    subject: '',
    created: null,
    modified: null,
    state: 'None',
    locked: false,
    rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
  };
}

function thread(
  root: CommentDto,
  replies: CommentDto[] = [],
  status: CommentThreadDto['status'] = 'None',
): CommentThreadDto {
  return { comment: root, replies, status };
}

const ANA = thread(comment(0, 'Ana', 'Check the total'), [comment(0, 'Ben', 'Fixed')], 'Accepted');
const CARL = thread(comment(1, 'Carl', 'Wrong font', 'Highlight'));
const THREADS = [ANA, CARL];

describe('comments filters', () => {
  it('matches the search against the text and the author of every comment in a thread', () => {
    expect(visibleThreads(THREADS, { ...NO_FILTER, search: 'total' })).toEqual([ANA]);
    expect(visibleThreads(THREADS, { ...NO_FILTER, search: '  CARL ' })).toEqual([CARL]);
    expect(visibleThreads(THREADS, { ...NO_FILTER, search: 'nothing' })).toEqual([]);
  });

  it('matches an author who wrote only a reply, and keeps the whole thread', () => {
    expect(visibleThreads(THREADS, { ...NO_FILTER, author: 'Ben' })).toEqual([ANA]);
    expect(visibleThreads(THREADS, { ...NO_FILTER, author: 'Ana' })).toEqual([ANA]);
  });

  it('filters by the thread status, which is the latest state, not a reply state', () => {
    expect(threadMatches(ANA, { ...NO_FILTER, status: 'Accepted' })).toBe(true);
    expect(threadMatches(ANA, { ...NO_FILTER, status: 'None' })).toBe(false);
  });

  it('filters by the type of the root comment', () => {
    expect(visibleThreads(THREADS, { ...NO_FILTER, type: 'Highlight' })).toEqual([CARL]);
  });

  it('combines the filters with AND', () => {
    expect(visibleThreads(THREADS, { ...NO_FILTER, author: 'Ben', status: 'None' })).toEqual([]);
  });

  it('offers the values the list has, in a fixed status order, without blank authors', () => {
    const options = filterOptions(
      [ANA, CARL, thread(comment(2, '', 'anon'), [], 'Completed')],
      NO_FILTER,
    );
    expect(options.authors).toEqual(['Ana', 'Ben', 'Carl']);
    expect(options.types).toEqual(['Highlight', 'Text']);
    expect(options.statuses).toEqual(['None', 'Accepted', 'Completed']);
  });

  it('keeps the current choice in the options even when no thread has it now', () => {
    const options = filterOptions(THREADS, { ...NO_FILTER, author: 'Gone', status: 'Rejected' });
    expect(options.authors).toContain('Gone');
    expect(options.statuses).toContain('Rejected');
  });
});
