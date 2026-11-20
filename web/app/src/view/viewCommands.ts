// The View zoom commands and the Home page-step commands (W4.2a S6): each is one call on the open
// document's view handle, so the ribbon, the app menu, the palette and the shortcuts share one path.
// Back and Forward are not here: they move through the navigation history the app keeps (W5.3).
import type { DocumentViewHandle } from './DocumentView';

export type ViewCommandId =
  'zoom-in' | 'zoom-out' | 'fit-width' | 'fit-page' | 'actual-size' | 'previous-page' | 'next-page';

// Runs one view command on the handle. Actual size is 100 %, the zoom of 1.
export function runViewCommand(id: ViewCommandId, view: DocumentViewHandle): void {
  switch (id) {
    case 'zoom-in':
      view.zoom({ step: 1 });
      return;
    case 'zoom-out':
      view.zoom({ step: -1 });
      return;
    case 'fit-width':
      view.zoom({ fit: 'width' });
      return;
    case 'fit-page':
      view.zoom({ fit: 'page' });
      return;
    case 'actual-size':
      view.zoom({ zoom: 1 });
      return;
    case 'previous-page':
      view.stepPage(-1);
      return;
    case 'next-page':
      view.stepPage(1);
      return;
  }
}
