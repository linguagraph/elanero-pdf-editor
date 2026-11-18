// The start-up screen (W1.6 section 10, W3.1). It is the first thing a user sees while the engine
// loads: the stages in order, the current one marked, and on failure the stage's message with a
// Retry button. It renders nothing before the load starts and after it is ready.
import type { Stage } from '../engine/protocol';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { mapLoadFailure } from '../rpc/errors';
import { engineLoad, useEngineLoadState, type EngineLoadStore, type LoadState } from './engineLoad';
import './feedback.css';

// The order of the stages the loader reports (loader.ts). 'ready' is the last one.
const STAGES: readonly Stage[] = ['pyodide', 'packages', 'engine', 'ready'];

const STAGE_LABEL: Record<Stage, MessageId> = {
  pyodide: 'loading.stage.pyodide',
  packages: 'loading.stage.packages',
  engine: 'loading.stage.engine',
  ready: 'loading.stage.ready',
};

export interface LoadingScreenProps {
  state: LoadState;
  onRetry: () => void;
}

export function LoadingScreen({ state, onRetry }: LoadingScreenProps) {
  if (state.status === 'idle' || state.status === 'ready') return null;

  if (state.status === 'failed') {
    const presentation = mapLoadFailure(state.stage);
    return (
      <section className="loading-screen" aria-labelledby="loading-screen-title">
        <h2 id="loading-screen-title" className="loading-title">
          {t('loading.failed.title')}
        </h2>
        <p className="loading-message" role="alert">
          {t(presentation.messageId, presentation.params)}
        </p>
        <button type="button" className="feedback-primary" onClick={onRetry}>
          {t('loading.retry')}
        </button>
      </section>
    );
  }

  const current = STAGES.indexOf(state.stage);
  return (
    <section className="loading-screen" aria-labelledby="loading-screen-title">
      <h2 id="loading-screen-title" className="loading-title">
        {t('loading.title')}
      </h2>
      <progress
        className="loading-bar"
        aria-label={t('loading.stages.label')}
        value={current}
        max={STAGES.length - 1}
      />
      <ol className="loading-stages" aria-label={t('loading.stages.label')} aria-live="polite">
        {STAGES.map((stage, index) => {
          const isCurrent = index === current;
          const isDone = index < current;
          return (
            <li
              key={stage}
              data-state={isDone ? 'done' : isCurrent ? 'current' : 'pending'}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span>{t(STAGE_LABEL[stage])}</span>
              {isDone ? <span className="visually-hidden">, {t('loading.stage.done')}</span> : null}
              {isCurrent ? (
                <span className="visually-hidden">, {t('loading.stage.current')}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// The loading screen wired to the engine load store. App mounts this one.
export function EngineLoadingScreen({ store = engineLoad }: { store?: EngineLoadStore }) {
  const state = useEngineLoadState(store);
  return <LoadingScreen state={state} onRetry={store.retry} />;
}
