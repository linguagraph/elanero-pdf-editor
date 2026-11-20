import { useState } from 'react';
import { Button, Tooltip, TooltipTrigger } from 'react-aria-components';
import { t } from '../i18n/t';
import { openCommandPalette } from '../palette/openCommandPalette';
import { Icon } from '../theme/Icon';

// How long the pointer rests on the icon before its tooltip shows (as the other ribbon buttons).
const TOOLTIP_DELAY_MS = 400;

export interface SearchToolsProps {
  // The icon button of the compact, collapsed and narrow forms; the box otherwise (W1.6 section 2).
  iconOnly: boolean;
}

// The "Search tools" control at the tab row's end. Typing in the box opens the command palette with
// what was typed as its query, so the box is a way into the palette, not a second search. The
// icon opens the palette empty.
export function SearchTools({ iconOnly }: SearchToolsProps) {
  if (iconOnly) {
    return (
      <TooltipTrigger delay={TOOLTIP_DELAY_MS}>
        <Button
          className="ribbon-search-button"
          aria-label={t('ribbon.searchTools')}
          onPress={() => openCommandPalette()}
        >
          <Icon name="search" size={16} />
        </Button>
        <Tooltip className="ribbon-tooltip">{t('ribbon.searchTools')}</Tooltip>
      </TooltipTrigger>
    );
  }
  return <SearchBox />;
}

// The box is cleared as the palette opens, since the palette takes the query and focus. The first
// typed character opens it (IME composition does not, since the text is not final yet), and Enter
// opens it with whatever is in the box.
function SearchBox() {
  const [value, setValue] = useState('');
  return (
    <input
      type="search"
      className="ribbon-search"
      aria-label={t('ribbon.searchTools')}
      placeholder={t('ribbon.searchTools')}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        // An input event carries isComposing, which the DOM's Event type does not declare.
        if ((event.nativeEvent as InputEvent).isComposing) {
          setValue(next);
          return;
        }
        if (next === '') {
          setValue('');
          return;
        }
        setValue('');
        openCommandPalette({ query: next });
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key !== 'Enter') return;
        event.preventDefault();
        const query = value;
        setValue('');
        openCommandPalette({ query });
      }}
    />
  );
}
