// The base path the app is served under (W9.2). GitHub Pages publishes the site at
// /elanero-pdf-editor/app/, next to the landing page and the user guide, so the production build
// must put that folder into every asset URL. The dev server keeps "/" so local work is unchanged.
// Plain TypeScript with no imports, so vite.config.ts and the tests share it.
export const PRODUCTION_BASE = '/elanero-pdf-editor/app/';

export type BaseCommand = 'build' | 'serve';

export function baseFor(command: BaseCommand): string {
  return command === 'build' ? PRODUCTION_BASE : '/';
}
