// The inline reply under a thread (W7.1b S4): a text box with Post and Cancel. Post is disabled
// while the text is blank, and Escape cancels, as the desktop's reply dialog does.
import { useId, useState } from 'react';
import { t } from '../../i18n/t';

export interface ReplyBoxProps {
  // Called with the text when Post is chosen (the text is not blank).
  readonly onPost: (text: string) => void;
  readonly onCancel: () => void;
}

export function ReplyBox({ onPost, onCancel }: ReplyBoxProps) {
  const [text, setText] = useState('');
  const id = useId();
  const blank = text.trim() === '';
  return (
    <form
      className="comments-reply-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blank) onPost(text);
      }}
    >
      <label htmlFor={id}>{t('comments.reply.label')}</label>
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
        <button type="submit" disabled={blank}>
          {t('comments.reply.post')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('comments.reply.cancel')}
        </button>
      </div>
    </form>
  );
}
