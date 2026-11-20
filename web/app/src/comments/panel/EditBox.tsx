// The inline editor of a comment's text (W7.1b S5): a text area that starts with the current text,
// with Save and Cancel. Escape cancels, as in the reply box. The text is sent as typed, so a
// blank comment is allowed (the file allows one).
import { useId, useState } from 'react';
import { t } from '../../i18n/t';

export interface EditBoxProps {
  readonly initial: string;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}

export function EditBox({ initial, onSave, onCancel }: EditBoxProps) {
  const [text, setText] = useState(initial);
  const id = useId();
  return (
    <form
      className="comments-reply-box"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text);
      }}
    >
      <label htmlFor={id}>{t('comments.edit.label')}</label>
      <textarea
        id={id}
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      />
      <div className="comments-actions">
        <button type="submit">{t('comments.edit.save')}</button>
        <button type="button" onClick={onCancel}>
          {t('comments.edit.cancel')}
        </button>
      </div>
    </form>
  );
}
