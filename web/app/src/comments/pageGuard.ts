// What a press or a key on these is not a page press: a control, a field, a menu, a dialog or a
// popover over the page keeps its own press, so the selection does not change under it, and an open
// note popup stays open (and saved only by its own close) while the press is in one of them.
export const NOT_PAGE_SELECTOR = [
  '.overlay-backdrop',
  'input',
  'textarea',
  'select',
  'button',
  '[role=menu]',
  '[role=menuitem]',
  '[role=dialog]',
  '[role=listbox]',
  "[class*='popover']",
  "[class*='menu']",
].join(', ');
