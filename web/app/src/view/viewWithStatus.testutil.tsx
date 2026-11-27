// Test helper (#808 slice 1): the document view with the status bar beside it, composed the way the
// app composes them, so a test reads the zoom box and the page field the reader sees. The bar sits
// in the app frame's footer; here it is a sibling of the view, which is enough for the controls.
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { DocumentStatusBar } from './DocumentStatusBar';
import {
  DocumentView,
  type DocumentViewHandle,
  type DocumentViewProps,
  type DocumentViewState,
} from './DocumentView';

export const ViewWithStatus = forwardRef<DocumentViewHandle, DocumentViewProps>(
  function ViewWithStatus(props, ref) {
    const inner = useRef<DocumentViewHandle>(null);
    const pageFieldRef = useRef<HTMLInputElement>(null);
    const [state, setState] = useState<DocumentViewState | null>(null);
    useImperativeHandle(ref, () => inner.current as DocumentViewHandle);
    // A stable callback: the view lists onViewChange as an effect dependency, so a new function on
    // every render would report again on every render, without end.
    const reportRef = useRef(props.onViewChange);
    reportRef.current = props.onViewChange;
    const report = useCallback((next: DocumentViewState) => {
      setState(next);
      reportRef.current?.(next);
    }, []);
    return (
      <>
        <DocumentView {...props} ref={inner} onViewChange={report} />
        {state === null ? null : (
          <DocumentStatusBar
            page={state.page}
            total={state.pageCount}
            labels={state.labels}
            zoom={state.zoom}
            fit={state.fit}
            pageFieldRef={pageFieldRef}
            onGoTo={(index) => inner.current?.scrollToPage(index)}
            onStep={(direction) => inner.current?.stepPage(direction)}
            onZoom={(request) => inner.current?.zoom(request)}
            onZoomStep={(direction) => inner.current?.zoom({ step: direction })}
          />
        )}
      </>
    );
  },
);
