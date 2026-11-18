// The beforeunload warning for unsaved changes (W1.6 section 3). The browser shows its own generic
// text, so the handler only asks for the prompt. The caller attaches it while a tab is dirty and
// calls the returned function to detach it.

export function guardUnload(target: Window): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    event.returnValue = '';
  };
  target.addEventListener('beforeunload', onBeforeUnload);
  return () => {
    target.removeEventListener('beforeunload', onBeforeUnload);
  };
}
