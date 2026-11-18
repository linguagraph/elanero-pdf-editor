import { describe, expect, it } from 'vitest';
import { guardUnload } from './unloadGuard';

// Fires beforeunload on a window and reports whether the handler asked for the prompt.
function fireUnload(target: Window): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('beforeunload guard', () => {
  it('asks for the browser prompt while attached', () => {
    const detach = guardUnload(window);
    expect(fireUnload(window)).toBe(true);
    detach();
  });

  it('stops asking once detached, so a clean page closes without a prompt', () => {
    const detach = guardUnload(window);
    detach();
    expect(fireUnload(window)).toBe(false);
  });
});
