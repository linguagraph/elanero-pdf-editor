// W8.5 S4 keyboard helpers: what the focused element is, where it sits, and whether a sighted
// keyboard user can see it. A walkthrough reads the focus after each key press, so a lost focus
// (on BODY) or an invisible ring fails at the step that caused it, not at the end of the test.
import { expect, type Locator, type Page } from '@playwright/test';

export interface FocusInfo {
  // The element's tag and class, for the failure message.
  readonly target: string;
  // Its accessible-ish name: aria-label, else its text.
  readonly name: string;
  // The data-region of the nearest region ('-' when none, as for the dialogs portaled to the body).
  readonly region: string;
  readonly onBody: boolean;
  // A focus ring the eye can see: a non-none outline with a width, or a box shadow.
  readonly ringed: boolean;
}

export async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) {
      return { target: 'BODY', name: '', region: '-', onBody: true, ringed: false };
    }
    const style = getComputedStyle(el);
    const ringed =
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none';
    return {
      target: `${el.tagName.toLowerCase()}.${el.className}`.replace(/\.$/, ''),
      name: el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40),
      region: el.closest('[data-region]')?.getAttribute('data-region') ?? '-',
      onBody: false,
      ringed,
    };
  });
}

// Presses Tab `count` times and returns the focus after each press.
export async function tabWalk(page: Page, count: number): Promise<FocusInfo[]> {
  const stops: FocusInfo[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    stops.push(await focusInfo(page));
  }
  return stops;
}

// Asserts that the focus is on a real element with a visible ring (not BODY, not an invisible
// control). The step name goes into the message so a failure says which key press caused it.
export async function expectVisibleFocus(page: Page, step: string): Promise<void> {
  const info = await focusInfo(page);
  expect(info.onBody, `${step}: focus is on BODY`).toBe(false);
  expect(info.ringed, `${step}: focused ${info.target} "${info.name}" has no visible ring`).toBe(
    true,
  );
}

// The focused element is inside the given locator (a dialog, a region). Used to check a dialog
// keeps the focus while the user tabs around it.
export async function expectFocusWithin(
  page: Page,
  container: Locator,
  step: string,
): Promise<void> {
  const inside = await container.evaluate((node) => node.contains(document.activeElement));
  const info = await focusInfo(page);
  expect(inside, `${step}: focus left the container (now ${info.target} "${info.name}")`).toBe(
    true,
  );
}
