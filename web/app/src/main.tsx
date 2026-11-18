import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FRAME_REFUSAL_MESSAGE, shouldRefuse } from './frame';

// The frame check runs before anything renders, so a framed copy never shows the app.
if (shouldRefuse(window)) {
  document.body.textContent = FRAME_REFUSAL_MESSAGE;
} else {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('index.html has no #root element');
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
