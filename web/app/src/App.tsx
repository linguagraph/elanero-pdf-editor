import { About } from './about';
import { APP_VERSION } from './version';

// Placeholder shell: no feature code yet (W4.3 onwards).
export function App() {
  return (
    <main>
      <h1>Elanero</h1>
      <p>Version {APP_VERSION}</p>
      <About />
    </main>
  );
}
