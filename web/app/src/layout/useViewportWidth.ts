import { useEffect, useState } from 'react';

// The window's width, kept current on resize. The layout is chosen from this, not from CSS media
// queries, so the breakpoint values live only in the tokens module.
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => {
      setWidth(window.innerWidth);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return width;
}
