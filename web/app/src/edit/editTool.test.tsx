import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setViewTool, useViewTool, type ViewTool } from '../view/viewTool';
import { acceptSignedEdit, requestEditTool } from './editTool';
import { SignedWarningDialog } from './signedWarning';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, '\\$&') },
  });
}

// The tool store notifies the hook synchronously; the calls run inside act so the probe re-renders.
function inAct<T>(fn: () => T): T {
  let out: T | undefined;
  act(() => {
    out = fn();
  });
  return out as T;
}

// Each test gets its own tab numbers, since the tool and the warnings are module state.
let nextTab = 5000;
function freshTab(): number {
  nextTab += 1;
  return nextTab;
}

let host: HTMLDivElement;
let root: Root;

// Shows the tab's view tool through the hook, as the app does; the test reads it from the page.
function Probe({ tabId }: { tabId: number }) {
  const tool: ViewTool = useViewTool(tabId);
  return <span data-testid="tool">{tool}</span>;
}

function mountProbe(tabId: number): void {
  act(() => {
    root.render(<Probe tabId={tabId} />);
  });
}

function lastTool(): string | null | undefined {
  return host.querySelector('[data-testid="tool"]')?.textContent;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('requestEditTool', () => {
  it('turns the Edit tool on for an unsigned document', () => {
    const tab = freshTab();
    mountProbe(tab);
    expect(inAct(() => requestEditTool(tab, false))).toBe(true);
    expect(lastTool()).toBe('edit');
  });

  it('keeps a signed document off the Edit tool until the warning is accepted', () => {
    const tab = freshTab();
    mountProbe(tab);
    expect(inAct(() => requestEditTool(tab, true))).toBe(false);
    expect(lastTool()).toBe('select');
    inAct(() => acceptSignedEdit(tab));
    expect(lastTool()).toBe('edit');
  });

  it('warns a signed document once per tab', () => {
    const tab = freshTab();
    mountProbe(tab);
    inAct(() => acceptSignedEdit(tab));
    inAct(() => setViewTool(tab, 'select'));
    expect(inAct(() => requestEditTool(tab, true))).toBe(true);
    expect(lastTool()).toBe('edit');
  });

  it('leaves the tool off after Cancel, and asks again next time', () => {
    const tab = freshTab();
    mountProbe(tab);
    expect(inAct(() => requestEditTool(tab, true))).toBe(false);
    expect(inAct(() => requestEditTool(tab, true))).toBe(false);
    expect(lastTool()).toBe('select');
  });

  it('warns each tab separately', () => {
    const first = freshTab();
    const second = freshTab();
    inAct(() => acceptSignedEdit(first));
    mountProbe(second);
    expect(inAct(() => requestEditTool(second, true))).toBe(false);
    expect(lastTool()).toBe('select');
  });
});

// The warning's buttons, read from the page: the overlay is portalled into the document body.
function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

describe('SignedWarningDialog', () => {
  it('calls onAccept from Continue and onCancel from Cancel', () => {
    const calls: string[] = [];
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <SignedWarningDialog
          isOpen={open}
          onAccept={() => {
            calls.push('accept');
            setOpen(false);
          }}
          onCancel={() => {
            calls.push('cancel');
            setOpen(false);
          }}
        />
      );
    }
    act(() => {
      root.render(<Host />);
    });
    expect(document.body.textContent).toContain('This document is signed');
    act(() => {
      buttonNamed('Cancel').click();
    });
    expect(calls).toEqual(['cancel']);
  });
});
