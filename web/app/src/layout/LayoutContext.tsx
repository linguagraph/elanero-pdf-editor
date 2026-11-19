import { createContext, type ReactNode, useContext } from 'react';
import { layoutForWidth, type LayoutRegions } from './breakpoints';

// The regions for the window width, provided once by AppFrame. Every layout consumer reads them
// from here, so there is one width listener and one answer per width. Outside a frame (a component
// rendered alone) the regions come from the window width at render time.
const LayoutContext = createContext<LayoutRegions | null>(null);

export function LayoutProvider({
  regions,
  children,
}: {
  readonly regions: LayoutRegions;
  readonly children: ReactNode;
}) {
  return <LayoutContext.Provider value={regions}>{children}</LayoutContext.Provider>;
}

export function useLayoutRegions(): LayoutRegions {
  const provided = useContext(LayoutContext);
  return provided ?? layoutForWidth(window.innerWidth);
}
