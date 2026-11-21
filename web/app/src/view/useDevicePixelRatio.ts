// The device pixel ratio as React state, so a change re-renders what is drawn at that ratio (W5.1b
// S4). Reading window.devicePixelRatio during a render never re-renders by itself. The browser
// reports a change through a resolution media query, which stops matching when the ratio moves
// (a window dragged to another screen, or browser zoom). The query is re-armed at the new ratio after
// each change. A resize is a fallback for browsers that do not fire the query on a monitor move.
import { useEffect, useState } from 'react';

export function currentPixelRatio(): number {
  return window.devicePixelRatio || 1;
}

export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(currentPixelRatio);
  useEffect(() => {
    let query: MediaQueryList | null = null;
    // Setting the same ratio again bails out in React, so a resize without a change re-renders nothing.
    function update(): void {
      setRatio(currentPixelRatio());
      arm();
    }
    function arm(): void {
      query?.removeEventListener('change', update);
      query = null;
      if (typeof window.matchMedia !== 'function') return;
      query = window.matchMedia(`(resolution: ${currentPixelRatio()}dppx)`);
      query.addEventListener('change', update);
    }
    arm();
    window.addEventListener('resize', update);
    return () => {
      query?.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return ratio;
}
