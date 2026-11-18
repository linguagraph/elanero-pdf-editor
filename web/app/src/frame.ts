// Clickjacking defence: a meta CSP cannot set frame-ancestors, so the app refuses to start
// when it is framed. Kept pure so the decision can be tested with a window-like object.

export const FRAME_REFUSAL_MESSAGE = 'Elanero cannot run inside another page.';

export interface WindowLike {
  readonly top: unknown;
  readonly self: unknown;
}

export function shouldRefuse(win: WindowLike): boolean {
  return win.top !== win.self;
}
