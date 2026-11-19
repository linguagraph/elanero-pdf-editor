// Mounts the not-responding dialog once, from the app's store (W4.4b). Nothing else renders the
// dialog, so there is only ever one, whatever number of calls time out.
import { NotRespondingDialog } from './NotRespondingDialog';
import { notResponding, type NotRespondingStore, useNotResponding } from './notResponding';

export function NotRespondingHost({ store = notResponding }: { store?: NotRespondingStore }) {
  const { error } = useNotResponding(store);
  return (
    <NotRespondingDialog error={error} onWait={store.wait} onRestart={() => void store.restart()} />
  );
}
