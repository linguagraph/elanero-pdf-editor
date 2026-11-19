// The search side panel (W5.4, W1.6 section 4): a query, its options, the hits in page order and
// next and previous. The engine searches in slices (text.search); Stop ends the run after the slice
// in flight, and the hits found so far stay. The hits are drawn on the page views through onMarks,
// and choosing one asks the view to scroll to its page through onGoTo.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import type { SearchHitDto, SearchOptionsDto } from '../rpc/generated';
import { collectSearch, nextHit, previousHit, type SearchMarks } from './search';
import './search.css';

export interface SearchPanelProps {
  readonly rpc: Pick<PageRpc, 'chunked'>;
  readonly handle: string;
  // The hits and the selected one, or null when there is nothing to draw.
  readonly onMarks: (marks: SearchMarks | null) => void;
  // Called with the zero-based page of a hit the user chose or the first hit found.
  readonly onGoTo: (page: number) => void;
  readonly onClose: () => void;
}

type Status = 'idle' | 'searching' | 'done' | 'stopped' | 'failed';

interface RunView {
  readonly status: Status;
  readonly hits: readonly SearchHitDto[];
  readonly current: number;
  readonly pagesDone: number;
  readonly total: number;
}

const IDLE: RunView = { status: 'idle', hits: [], current: -1, pagesDone: 0, total: 0 };

const NO_OPTIONS: SearchOptionsDto = { case_sensitive: false, whole_word: false, regex: false };

function statusText(view: RunView): string {
  switch (view.status) {
    case 'searching':
      return t('search.progress', { done: view.pagesDone, total: view.total });
    case 'stopped':
      return t('search.stopped', { count: view.hits.length });
    case 'failed':
      return t('search.failed');
    case 'done':
      if (view.hits.length === 0) return t('search.noMatches');
      return view.current >= 0
        ? t('search.count', { current: view.current + 1, count: view.hits.length })
        : t('search.countTotal', { count: view.hits.length });
    case 'idle':
      return view.hits.length > 0 ? t('search.countTotal', { count: view.hits.length }) : '';
  }
}

export function SearchPanel({ rpc, handle, onMarks, onGoTo, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptionsDto>(NO_OPTIONS);
  const [view, setView] = useState<RunView>(IDLE);
  // The run in progress. Starting a new run, or stopping, replaces or clears it, so a slice from
  // an old run is ignored.
  const runRef = useRef<AbortController | null>(null);
  const onMarksRef = useRef(onMarks);
  const onGoToRef = useRef(onGoTo);

  useEffect(() => {
    onMarksRef.current = onMarks;
    onGoToRef.current = onGoTo;
  }, [onMarks, onGoTo]);

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
    setView({ status: 'searching', hits: [], current: -1, pagesDone: 0, total: 0 });
    collectSearch(rpc, handle, query, options, controller.signal, (hits, pagesDone, total) => {
      if (runRef.current !== controller) return;
      const first = found.length === 0 && hits.length > 0;
      found = [...found, ...hits];
      if (first) onGoToRef.current(found[0]?.page ?? 0);
      setView((previous) => ({
        ...previous,
        hits: found,
        current: first ? 0 : previous.current,
        pagesDone,
        total,
      }));
    }).then(
      () => {
        if (runRef.current !== controller) return;
        runRef.current = null;
        setView((previous) => ({ ...previous, status: 'done' }));
      },
      () => {
        if (runRef.current !== controller) return;
        runRef.current = null;
        setView((previous) => ({ ...previous, status: 'failed' }));
      },
    );
  };

  const choose = (index: number) => {
    const hit = view.hits[index];
    if (hit === undefined) return;
    setView((previous) => ({ ...previous, current: index }));
    onGoTo(hit.page);
  };

  const count = view.hits.length;
  const goPrevious = () => {
    const index = previousHit(view.current, count);
    if (index >= 0) choose(index);
  };
  const goNext = () => {
    const index = nextHit(view.current, count);
    if (index >= 0) choose(index);
  };
  const setOption = (key: keyof SearchOptionsDto, value: boolean) =>
    setOptions((previous) => ({ ...previous, [key]: value }));

  return (
    <Panel title={t('search.title')} onClose={onClose}>
      <form className="search-form" role="search" onSubmit={submit}>
        <input
          type="search"
          aria-label={t('search.query')}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
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
        <button type="button" disabled={count === 0} onClick={goPrevious}>
          {t('search.previous')}
        </button>
        <button type="button" disabled={count === 0} onClick={goNext}>
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
        <ol className="search-results" aria-label={t('search.results')}>
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
