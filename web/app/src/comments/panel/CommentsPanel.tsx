// The Comments side panel (W7.1b S3, read-only): the document's comment threads, each with its
// replies under it. A row shows the page, the type (for the root), the author, the date, the
// thread's status and the text. The filters (search, type, author, status) come from the
// controller, which keeps a thread whole when a reply matches. Clicking a row, or pressing Enter on
// it, goes to the comment's page. Each thread takes a reply and a new status (S4, through
// annotations.reply, with Undo); edit and delete come in S5.
import { useId, useState, useSyncExternalStore } from 'react';
import { formatDate } from '../../i18n/format';
import type { MessageId } from '../../i18n/en';
import { t } from '../../i18n/t';
import { Panel } from '../../layout/Panel';
import type { PageRpc } from '../../engine/engineConnection';
import type { AnnotationType, CommentDto, ReviewState } from '../../rpc/generated';
import type { RenderScheduler } from '../../view/renderScheduler';
import type { CommentsController } from './controller';
import { type EditDeps, replyTo, setStatus, STATUS_CHOICES } from './edits';
import { ReplyBox } from './ReplyBox';
import './panel.css';

export interface CommentsPanelProps {
  readonly controller: CommentsController;
  // The document the replies and status changes go to, and the scheduler that redraws the pages
  // they change.
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
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

export function CommentsPanel({
  controller,
  rpc,
  handle,
  scheduler,
  onGoTo,
  onClose,
}: CommentsPanelProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const searchId = useId();
  // The thread whose reply box is open, by its key (page and name); one box at a time.
  const [replying, setReplying] = useState<string | null>(null);
  const { threads, visible, options, filter, loaded, truncated } = state;
  const editDeps: EditDeps = { rpc, handle, scheduler, controller };

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
            {visible.map((thread) => {
              const key = `${thread.comment.page}:${thread.comment.name}`;
              return (
                <li key={key} className="comments-thread">
                  <Entry comment={thread.comment} root status={thread.status} onGoTo={onGoTo} />
                  <div className="comments-thread-actions">
                    <button type="button" onClick={() => setReplying(key)}>
                      {t('comments.reply.open')}
                    </button>
                    <select
                      aria-label={t('comments.status.set')}
                      value=""
                      onChange={(event) => {
                        const choice = pick(STATUS_CHOICES, event.target.value);
                        if (choice !== null) void setStatus(editDeps, thread.comment, choice);
                      }}
                    >
                      <option value="">{t('comments.status.set')}</option>
                      {STATUS_CHOICES.map((choice) => (
                        <option key={choice} value={choice}>
                          {t(STATUS_LABEL[choice])}
                        </option>
                      ))}
                    </select>
                  </div>
                  {thread.replies.length === 0 ? null : (
                    <ul aria-label={t('comments.replies')} className="comments-replies">
                      {thread.replies.map((reply) => (
                        <li key={`${reply.page}:${reply.name}`}>
                          <Entry comment={reply} root={false} onGoTo={onGoTo} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {replying === key ? (
                    <ReplyBox
                      onPost={(text) =>
                        void replyTo(editDeps, thread.comment, text).then((sent) => {
                          if (sent) setReplying(null);
                        })
                      }
                      onCancel={() => setReplying(null)}
                    />
                  ) : null}
                </li>
              );
            })}
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
