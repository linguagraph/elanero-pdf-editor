import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { SaveAsDialog, type SaveAsSource } from './SaveAsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

const PLAIN: SaveAsSource = { name: 'report.pdf', signed: false, encrypted: false };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// The dialog renders in a portal on the body, so queries go to the document.
function input(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>('.saveas-form input');
  if (field === null) throw new Error('no name field');
  return field;
}

function submitButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button === null) throw new Error('no submit button');
  return button;
}

function render(tab: SaveAsSource | null, onSave = vi.fn(), onCancel = vi.fn()) {
  act(() => root.render(<SaveAsDialog tab={tab} onSave={onSave} onCancel={onCancel} />));
  return { onSave, onCancel };
}

function typeName(value: string): void {
  act(() => {
    const field = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SaveAsDialog', () => {
  it('shows nothing while closed', () => {
    render(null);
    expect(document.querySelector('.saveas-form')).toBeNull();
  });

  it('prefills the tab name and selects the part before the .pdf suffix', () => {
    render(PLAIN);
    expect(input().value).toBe('report.pdf');
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe('report'.length);
  });

  it('saves under the typed name, with the .pdf suffix added when it is missing', () => {
    const { onSave } = render(PLAIN);
    typeName('summary');
    act(() => {
      submitButton().click();
    });
    expect(onSave).toHaveBeenCalledWith('summary.pdf');
  });

  it('saves under the tab name when the name is blank', () => {
    const { onSave } = render(PLAIN);
    typeName('   ');
    act(() => {
      submitButton().click();
    });
    expect(onSave).toHaveBeenCalledWith('report.pdf');
  });

  it('removes the characters a file name cannot have', () => {
    const { onSave } = render(PLAIN);
    typeName('a/b:c.pdf');
    act(() => {
      submitButton().click();
    });
    expect(onSave).toHaveBeenCalledWith('abc.pdf');
  });

  it('cancels without saving when Cancel is pressed', () => {
    const { onSave, onCancel } = render(PLAIN);
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === t('action.cancel'),
    );
    act(() => {
      cancel?.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('says that a signed copy will not keep its signatures', () => {
    render({ ...PLAIN, signed: true });
    expect(document.body.textContent).toContain(t('saveAs.signedNote'));
  });

  it('says that an encrypted copy keeps the password, and shows no note for a plain document', () => {
    render({ ...PLAIN, encrypted: true });
    expect(document.body.textContent).toContain(t('saveAs.encryptedNote'));

    act(() => root.unmount());
    root = createRoot(container);
    render(PLAIN);
    expect(document.body.textContent).not.toContain(t('saveAs.encryptedNote'));
    expect(document.body.textContent).not.toContain(t('saveAs.signedNote'));
  });
});
