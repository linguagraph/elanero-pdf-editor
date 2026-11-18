import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FRAME_REFUSAL_MESSAGE, shouldRefuse } from './frame';
import { initTheme } from './theme/theme';
import './theme/tokens.css';

// The frame check runs before anything renders, so a framed copy never shows the app.
if (shouldRefuse(window)) {
  document.body.textContent = FRAME_REFUSAL_MESSAGE;
} else {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('index.html has no #root element');
  }
  initTheme();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
