// The comment tools in the document toolbar (W7.1a). Choosing the tool that is already on turns it
// off; with no tool on, a click or drag on a page does what it always did (text selection).
import { t } from '../i18n/t';
import { COMMENT_TOOL_LABEL, COMMENT_TOOLS, type CommentToolId } from './tools';

export interface CommentToolbarProps {
  readonly tool: CommentToolId | null;
  readonly onChoose: (tool: CommentToolId | null) => void;
}

export function CommentToolbar({ tool, onChoose }: CommentToolbarProps) {
  return (
    <div role="group" aria-label={t('comment.toolbarLabel')}>
      {COMMENT_TOOLS.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={tool === id}
          onClick={() => onChoose(tool === id ? null : id)}
        >
          {t(COMMENT_TOOL_LABEL[id])}
        </button>
      ))}
    </div>
  );
}
