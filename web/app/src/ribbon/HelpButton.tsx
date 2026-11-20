import { Button, Tooltip, TooltipTrigger } from 'react-aria-components';
import { type TabId } from '../commands/registry';
import { displayKeys, effectiveKeys, isMacPlatform } from '../commands/shortcuts';
import { openGuide, TAB_GUIDE_PAGE } from '../help/guide';
import { t } from '../i18n/t';
import { Icon } from '../theme/Icon';

const IS_MAC = isMacPlatform(navigator.platform);
// How long the pointer rests on the button before its tooltip shows (as the other ribbon buttons).
const TOOLTIP_DELAY_MS = 400;

export interface HelpButtonProps {
  // The ribbon tab shown; its guide page opens. With no tab shown, the guide's start opens.
  tab?: TabId;
}

// The "?" button at the tab row's end (W1.6 section 2). Its tooltip names the Help keys, so an
// override from the shortcut settings shows up.
export function HelpButton({ tab }: HelpButtonProps) {
  const keys = effectiveKeys('help');
  const tip =
    keys.length > 0 ? t('ribbon.helpTip', { keys: displayKeys(keys, IS_MAC) }) : t('ribbon.help');
  return (
    <TooltipTrigger delay={TOOLTIP_DELAY_MS}>
      <Button
        className="ribbon-help"
        aria-label={t('ribbon.help')}
        onPress={() => {
          openGuide(tab === undefined ? '' : TAB_GUIDE_PAGE[tab]);
        }}
      >
        <Icon name="circle-help" size={16} />
      </Button>
      <Tooltip className="ribbon-tooltip">{tip}</Tooltip>
    </TooltipTrigger>
  );
}
