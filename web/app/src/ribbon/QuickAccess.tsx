import { Toolbar } from 'react-aria-components';
import { type CommandHandlers, isVisible } from '../commands/run';
import { type CommandState, type Registry } from '../commands/registry';
import { QUICK_ACCESS, QUICK_ACCESS_NARROW } from '../commands/catalog';
import { BREAKPOINTS_PX } from '../theme/tokens';
import { t } from '../i18n/t';
import { useViewportWidth } from '../layout/useViewportWidth';
import { CommandButton } from './Ribbon';
import './ribbon.css';

// The desktop's quick-access icons are 16 px (the ribbon's are 22, or 18 when compact).
const QUICK_ACCESS_ICON_SIZE = 16;

export interface QuickAccessProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
}

// The quick-access buttons in the header (W1.6 section 2, the desktop's quick actions): icons only,
// and below 1024 px only Undo, Redo and Save. Each one is the same command as on the ribbon, so
// its enabled rule and its "not available yet" state come from the registry.
export function QuickAccess({ registry, state, handlers }: QuickAccessProps) {
  const width = useViewportWidth();
  const ids = width < BREAKPOINTS_PX.medium ? QUICK_ACCESS_NARROW : QUICK_ACCESS;
  const defs = ids.flatMap((id) => {
    const def = registry.get(id);
    return def !== undefined && isVisible(def, state) ? [def] : [];
  });
  return (
    <Toolbar aria-label={t('quickAccess.label')} className="quick-access">
      {defs.map((def) => (
        <CommandButton
          key={def.id}
          def={def}
          registry={registry}
          state={state}
          handlers={handlers}
          compact
          iconSize={QUICK_ACCESS_ICON_SIZE}
        />
      ))}
    </Toolbar>
  );
}
