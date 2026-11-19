import { createElement } from 'react';
import { ICONS, type IconName } from './icons.generated';

export interface IconProps {
  readonly name: IconName;
  // Width and height in CSS pixels; the icon grid is 24 units.
  readonly size?: number;
}

// A command icon from the bundled Lucide set (W1.6 section 7). The element data was checked by
// scripts/generate-icons.ts, so this builds the elements with createElement and never injects
// markup. Strokes use currentColor, so the icon takes the text colour of its surroundings.
export function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      className="icon"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name].map(([tag, attrs], index) => createElement(tag, { ...attrs, key: index }))}
    </svg>
  );
}
