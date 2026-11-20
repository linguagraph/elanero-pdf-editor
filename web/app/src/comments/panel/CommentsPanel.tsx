// The Comments side panel (W7.1b S3, read-only): the document's comment threads, each with its
// replies under it. A row shows the page, the type (for the root), the author, the date, the
// thread's status and the text. The filters (search, type, author, status) come from the
// controller, which keeps a thread whole when a reply matches. Clicking a row, or pressing Enter on
// it, goes to the comment's page. Reply, status and edit come in later slices.
import { useId, useSyncExternalStore } from 'react';
import { formatDate } from '../../i18n/format';
import type { MessageId } from '../../i18n/en';
import { t } from '../../i18n/t';
import { Panel } from '../../layout/Panel';
import type { AnnotationType, CommentDto, ReviewState } from '../../rpc/generated';
import type { CommentsController } from './controller';
import './panel.css';

export interface CommentsPanelProps {
  readonly controller: CommentsController;
  // Called with the comment's page (zero-based) and its name, so selection can come later
  // without a change here (W7.1a).
  readonly onGoTo: (page: number, name: string) => void;
  readonly onClose: () => void;
}

const TYPE_LABEL: Readonly<Record<AnnotationType, MessageId>> = {
  Text: 'comment.type.Text',
  FreeText: 'comment.type.FreeText',
  Line: 'comment.type.Line',
  Square: 'comment.type.Square',
  Circle: 'comment.type.Circle',
  Polygon: 'comment.type.Polygon',
  PolyLine: 'comment.type.PolyLine',
  Highlight: 'comment.type.Highlight',
  Underline: 'comment.type.Underline',
  Squiggly: 'comment.type.Squiggly',
  StrikeOut: 'comment.type.StrikeOut',
  Stamp: 'comment.type.Stamp',
  Caret: 'comment.type.Caret',
  Ink: 'comment.type.Ink',
  Popup: 'comment.type.Popup',
  FileAttachment: 'comment.type.FileAttachment',
  Redact: 'comment.type.Redact',
  Link: 'comment.type.Link',
  Widget: 'comment.type.Widget',
  Other: 'comment.type.Other',
};

const STATUS_LABEL: Readonly<Record<ReviewState, MessageId>> = {
  None: 'comment.status.None',
  Accepted: 'comment.status.Accepted',
  Rejected: 'comment.status.Rejected',
  Cancelled: 'comment.status.Cancelled',
  Completed: 'comment.status.Completed',
};

// The option of a select that the value names, or null for "All" (an empty value or a stale one).
function pick<T extends string>(options: readonly T[], value: string): T | null {
  return options.find((option) => option === value) ?? null;
}

interface EntryProps {
  readonly comment: CommentDto;
  // The root of a thread shows its type and status; a reply shows only its author and text.
  readonly root: boolean;
  readonly status?: ReviewState;
  readonly onGoTo: (page: number, name: string) => void;
}

function Entry({ comment, root, status, onGoTo }: EntryProps) {
  const when = comment.created === null ? null : formatDate(new Date(comment.created));
  return (
    <button
      type="button"
      className={root ? 'comments-entry' : 'comments-entry comments-reply'}
      onClick={() => onGoTo(comment.page, comment.name)}
    >
      <span className="comments-meta">
        <span>{t('comments.page', { page: comment.page + 1 })}</span>
        {root ? <span>{t(TYPE_LABEL[comment.type])}</span> : null}
        <span>{comment.author === '' ? t('comments.noAuthor') : comment.author}</span>
        {when === null ? null : <time dateTime={comment.created ?? undefined}>{when}</time>}
      </span>
      {status === undefined || status === 'None' ? null : (
        <span className="comments-status">{t(STATUS_LABEL[status])}</span>
      )}
      {comment.contents === '' ? null : <span className="comments-text">{comment.contents}</span>}
    </button>
  );
}

export function CommentsPanel({ controller, onGoTo, onClose }: CommentsPanelProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const searchId = useId();
  const { threads, visible, options, filter, loaded, truncated } = state;

  let body;
  if (!loaded) {
    body = (
      <p role="status" className="comments-status-line">
        {t('comments.loading')}
      </p>
    );
  } else if (threads.length === 0) {
    body = (
      <p role="status" className="comments-status-line">
        {t('comments.empty')}
      </p>
    );
  } else {
    body = (
      <>
        <div className="comments-filters">
          <label className="comments-field" htmlFor={searchId}>
            <span>{t('comments.search')}</span>
            <input
              id={searchId}
              type="search"
              value={filter.search}
              onChange={(event) => controller.setFilter({ search: event.target.value })}
            />
          </label>
          <label className="comments-field">
            <span>{t('comments.filter.type')}</span>
            <select
              value={filter.type ?? ''}
              onChange={(event) =>
                controller.setFilter({ type: pick(options.types, event.target.value) })
              }
            >
              <option value="">{t('comments.filter.all')}</option>
              {options.types.map((type) => (
                <option key={type} value={type}>
                  {t(TYPE_LABEL[type])}
                </option>
              ))}
            </select>
          </label>
          <label className="comments-field">
            <span>{t('comments.filter.author')}</span>
            <select
              value={filter.author ?? ''}
              onChange={(event) =>
                controller.setFilter({ author: pick(options.authors, event.target.value) })
              }
            >
              <option value="">{t('comments.filter.all')}</option>
              {options.authors.map((author) => (
                <option key={author} value={author}>
                  {author}
                </option>
              ))}
            </select>
          </label>
          <label className="comments-field">
            <span>{t('comments.filter.status')}</span>
            <select
              value={filter.status ?? ''}
              onChange={(event) =>
                controller.setFilter({ status: pick(options.statuses, event.target.value) })
              }
            >
              <option value="">{t('comments.filter.all')}</option>
              {options.statuses.map((status) => (
                <option key={status} value={status}>
                  {t(STATUS_LABEL[status])}
                </option>
              ))}
            </select>
          </label>
        </div>
        {truncated ? (
          <p role="status" className="comments-status-line">
            {t('comments.truncated')}
          </p>
        ) : null}
        {visible.length === 0 ? (
          <p role="status" className="comments-status-line">
            {t('comments.noMatch')}
          </p>
        ) : (
          <ul aria-label={t('comments.list')} className="comments-list">
            {visible.map((thread) => (
              <li key={`${thread.comment.page}:${thread.comment.name}`} className="comments-thread">
                <Entry comment={thread.comment} root status={thread.status} onGoTo={onGoTo} />
                {thread.replies.length === 0 ? null : (
                  <ul aria-label={t('comments.replies')} className="comments-replies">
                    {thread.replies.map((reply) => (
                      <li key={`${reply.page}:${reply.name}`}>
                        <Entry comment={reply} root={false} onGoTo={onGoTo} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <Panel title={t('comments.title')} onClose={onClose}>
      {body}
    </Panel>
  );
}
