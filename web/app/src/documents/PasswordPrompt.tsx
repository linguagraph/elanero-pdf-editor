import { useId, useState } from 'react';
import { Overlay } from '../layout/Overlay';
import { t } from '../i18n/t';
import {
  passwordPrompt,
  usePasswordRequest,
  type PasswordPrompt as Store,
} from './passwordRequest';

export interface PasswordPromptProps {
  store?: Store;
}

// The password dialog for a protected file (W3.1). It sits on the Overlay host, so focus is
// trapped and Escape cancels. The typed value lives in this form's state only: submitting or
// cancelling ends the request and the form unmounts with the value.
export function PasswordPrompt({ store = passwordPrompt }: PasswordPromptProps) {
  const request = usePasswordRequest(store);
  return (
    <Overlay
      isOpen={request !== null}
      onClose={() => {
        store.answer(null);
      }}
      title={t('password.title')}
      showCloseButton={false}
    >
      {request === null ? null : (
        <PasswordForm
          name={request.name}
          onSubmit={(password) => {
            store.answer(password);
          }}
          onCancel={() => {
            store.answer(null);
          }}
        />
      )}
    </Overlay>
  );
}

interface PasswordFormProps {
  name: string;
  onSubmit(password: string): void;
  onCancel(): void;
}

function PasswordForm({ name, onSubmit, onCancel }: PasswordFormProps) {
  const [value, setValue] = useState('');
  const id = useId();
  return (
    <form
      className="password-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== '') onSubmit(value);
      }}
    >
      <p id={`${id}-body`}>{t('password.body', { name })}</p>
      <label htmlFor={`${id}-input`}>{t('password.label')}</label>
      <input
        id={`${id}-input`}
        type="password"
        autoComplete="off"
        autoFocus
        aria-describedby={`${id}-body`}
        value={value}
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
      />
      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onCancel}>
          {t('action.cancel')}
        </button>
        <button type="submit" className="feedback-primary" disabled={value === ''}>
          {t('action.askPassword')}
        </button>
      </div>
    </form>
  );
}
