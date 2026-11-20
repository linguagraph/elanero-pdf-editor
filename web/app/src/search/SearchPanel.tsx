// The search side panel (W5.4, W1.6 section 4): a query, its options, the hits in page order and
// next and previous. The engine searches in slices (text.search) from the current page, wrapping
// round as the desktop does. Stop ends the run after the slice in flight, and the hits found so far
// stay; a new query cancels the run in progress. Enter and Shift+Enter step through the hits of the
// query already searched. The hits are drawn on the page views through onMarks, and choosing one
// asks the view to scroll to its page through onGoTo, and to bring the hit's rectangle into sight
// through onReveal.
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t, tp } from '../i18n/t';
import { Panel } from '../layout/Panel';
import { RpcError } from '../rpc/client';
import type { RectDto, SearchHitDto, SearchOptionsDto } from '../rpc/generated';
import { collectSearch, hitBounds, nextHit, previousHit, type SearchMarks } from './search';
import './search.css';

// A request from Find Next (F3) or Find Previous (Shift+F3). A new id is a new request.
export interface FindRequest {
  readonly direction: 1 | -1;
  readonly id: number;
}

export interface SearchPanelProps {
  readonly rpc: Pick<PageRpc, 'chunked'>;
  readonly handle: string;
  // The hits and the selected one, or null when there is nothing to draw.
  readonly onMarks: (marks: SearchMarks | null) => void;
  // Called with the zero-based page of a hit the user chose or the first hit found.
  readonly onGoTo: (page: number) => void;
  // Called with the chosen hit's page and its rectangle in points, so the view can scroll to the text.
  readonly onReveal?: (page: number, rect: RectDto) => void;
  readonly onClose: () => void;
  // Bumped by the caller to move focus to the query box, also when the panel is already open (Ctrl+F).
  readonly focusRequest?: number;
  // The zero-based page the search starts from. It wraps round to the first page (W1.4 section 10).
  readonly currentPage?: number;
  readonly findRequest?: FindRequest;
}

type Status = 'idle' | 'searching' | 'done' | 'stopped' | 'failed' | 'badQuery';

interface RunView {
  readonly status: Status;
  // The query the hits came from. Enter steps through them only while the query box still holds it.
  readonly query: string;
  readonly hits: readonly SearchHitDto[];
  readonly current: number;
  readonly pagesDone: number;
  readonly total: number;
  // The engine's reason for a refused query (status badQuery).
  readonly reason: string;
}

const IDLE: RunView = {
  status: 'idle',
  query: '',
  hits: [],
  current: -1,
  pagesDone: 0,
  total: 0,
  reason: '',
};

const NO_OPTIONS: SearchOptionsDto = { case_sensitive: false, whole_word: false, regex: false };

function statusText(view: RunView): string {
  switch (view.status) {
    case 'searching':
      return t('search.progress', { done: view.pagesDone, total: view.total });
    case 'stopped':
      return tp('search.stopped', view.hits.length);
    case 'failed':
      return t('search.failed');
    case 'badQuery':
      return t('search.badQuery', { reason: view.reason });
    case 'done':
      if (view.hits.length === 0) return t('search.noMatches');
      return view.current >= 0
        ? tp('search.count', view.hits.length, { current: view.current + 1 })
        : tp('search.countTotal', view.hits.length);
    case 'idle':
      return view.hits.length > 0
        ? tp('search.countTotal', view.hits.length)
        : t('search.emptyHint');
  }
}

export function SearchPanel({
  rpc,
  handle,
  onMarks,
  onGoTo,
  onReveal,
  onClose,
  focusRequest = 0,
  currentPage = 0,
  findRequest,
}: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // The last request handled. A panel that mounts with a request (Ctrl+F opened it) focuses too.
  const handledRequest = useRef(0);
  useEffect(() => {
    if (focusRequest === handledRequest.current) return;
    handledRequest.current = focusRequest;
    inputRef.current?.focus();
  }, [focusRequest]);
  const [options, setOptions] = useState<SearchOptionsDto>(NO_OPTIONS);
  const [view, setView] = useState<RunView>(IDLE);
  // The run in progress. Starting a new run, or stopping, replaces or clears it, so a slice from
  // an old run is ignored.
  const runRef = useRef<AbortController | null>(null);
  const onMarksRef = useRef(onMarks);
  const onGoToRef = useRef(onGoTo);
  const onRevealRef = useRef(onReveal);
  // The step of the latest render, for a Find Next or Previous request (an effect, so it is late).
  const stepRef = useRef<(direction: 1 | -1) => void>(() => undefined);
  const handledFind = useRef(findRequest?.id ?? 0);

  useEffect(() => {
    onMarksRef.current = onMarks;
    onGoToRef.current = onGoTo;
    onRevealRef.current = onReveal;
  }, [onMarks, onGoTo, onReveal]);

  const { hits, current } = view;
  useEffect(() => {
    if (hits.length === 0) onMarksRef.current(null);
    else onMarksRef.current({ hits, current });
  }, [hits, current]);

  // Leaving the panel stops a run and clears the highlights.
  useEffect(
    () => () => {
      runRef.current?.abort();
      runRef.current = null;
      onMarksRef.current(null);
    },
    [],
  );

  const choose = (index: number) => {
    const hit = view.hits[index];
    if (hit === undefined) return;
    setView((previous) => ({ ...previous, current: index }));
    onGoTo(hit.page);
    onReveal?.(hit.page, hitBounds(hit));
  };

  const count = view.hits.length;
  const step = (direction: 1 | -1) => {
    const index = direction > 0 ? nextHit(view.current, count) : previousHit(view.current, count);
    if (index >= 0) choose(index);
  };

  useEffect(() => {
    stepRef.current = step;
  });
  useEffect(() => {
    if (findRequest === undefined || findRequest.id === handledFind.current) return;
    handledFind.current = findRequest.id;
    stepRef.current(findRequest.direction);
  }, [findRequest]);

  const stop = () => {
    const running = runRef.current;
    if (running === null) return;
    runRef.current = null;
    running.abort();
    setView((previous) => ({ ...previous, status: 'stopped' }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runRef.current?.abort();
    runRef.current = null;
    // An empty query is not sent to the engine.
    if (query === '') {
      setView(IDLE);
      return;
    }
    const controller = new AbortController();
    runRef.current = controller;
    let found: SearchHitDto[] = [];
    setView({ ...IDLE, status: 'searching', query });
    collectSearch(
      rpc,
      handle,
      query,
      options,
      currentPage,
      controller.signal,
      (sliceHits, pagesDone, total) => {
        if (runRef.current !== controller) return;
        const first = found.length === 0 && sliceHits.length > 0;
        found = [...found, ...sliceHits];
        const firstHit = first ? found[0] : undefined;
        if (firstHit !== undefined) {
          onGoToRef.current(firstHit.page);
          onRevealRef.current?.(firstHit.page, hitBounds(firstHit));
        }
        setView((previous) => ({
          ...previous,
          hits: found,
          current: first ? 0 : previous.current,
          pagesDone,
          total,
        }));
      },
    ).then(
      () => {
        if (runRef.current !== controller) return;
        runRef.current = null;
        setView((previous) => ({ ...previous, status: 'done' }));
      },
      (error: unknown) => {
        if (runRef.current !== controller) return;
        runRef.current = null;
        // The engine names the part of the query it refused, such as a regex that does not parse.
        const refused = error instanceof RpcError && error.code === 'INVALID_ARGS';
        setView((previous) =>
          refused
            ? { ...previous, status: 'badQuery', reason: error.message }
            : { ...previous, status: 'failed' },
        );
      },
    );
  };

  // Enter steps to the next hit and Shift+Enter to the previous one, while the query box still
  // holds the query that was searched. Otherwise Enter searches as usual.
  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || count === 0 || view.query !== query) return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  };

  const setOption = (key: keyof SearchOptionsDto, value: boolean) =>
    setOptions((previous) => ({ ...previous, [key]: value }));

  return (
    <Panel title={t('search.title')} onClose={onClose}>
      <form className="search-form" role="search" onSubmit={submit}>
        <input
          ref={inputRef}
          type="search"
          aria-label={t('search.query')}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onQueryKeyDown}
        />
        <button type="submit">{t('search.submit')}</button>
      </form>
      <div className="search-options">
        <label>
          <input
            type="checkbox"
            checked={options.case_sensitive}
            onChange={(event) => setOption('case_sensitive', event.currentTarget.checked)}
          />
          {t('search.caseSensitive')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.whole_word}
            onChange={(event) => setOption('whole_word', event.currentTarget.checked)}
          />
          {t('search.wholeWord')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.regex}
            onChange={(event) => setOption('regex', event.currentTarget.checked)}
          />
          {t('search.regex')}
        </label>
      </div>
      <div className="search-actions">
        <button type="button" disabled={count === 0} onClick={() => step(-1)}>
          {t('search.previous')}
        </button>
        <button type="button" disabled={count === 0} onClick={() => step(1)}>
          {t('search.next')}
        </button>
        {view.status === 'searching' ? (
          <button type="button" onClick={stop}>
            {t('search.stop')}
          </button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="search-status">
        {statusText(view)}
      </p>
      {count > 0 ? (
        <ol className="search-results panel-fill" tabIndex={0} aria-label={t('search.results')}>
          {view.hits.map((hit, index) => (
            <li key={index}>
              <button
                type="button"
                aria-current={index === view.current}
                onClick={() => choose(index)}
              >
                <span className="search-hit-page">{t('search.page', { page: hit.page + 1 })}</span>
                {hit.context}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </Panel>
  );
}
