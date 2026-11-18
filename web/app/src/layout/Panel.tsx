import { useId, useState, type ReactNode } from 'react';
import { t } from '../i18n/t';
import './layout.css';

export interface PanelProps {
  // The panel's name, already translated by the caller. It is also the disclosure button's text.
  title: string;
  onClose: () => void;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  children: ReactNode;
}

// A panel frame (W1.6 section 4): a header with a disclosure button and a close button, and a body
// that can be collapsed. The state is announced twice: aria-expanded on the button, and a status
// message that a screen reader reads when it changes.
export function Panel({
  title,
  onClose,
  defaultCollapsed = false,
  onCollapsedChange,
  children,
}: PanelProps) {
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    onCollapsedChange?.(next);
  };

  return (
    <section className="panel" data-collapsed={collapsed ? 'true' : 'false'}>
      <header className="panel-header">
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={toggle}
        >
          {title}
        </button>
        <button
          type="button"
          className="panel-close"
          aria-label={t('panel.close', { title })}
          onClick={onClose}
        >
          <svg
            className="panel-close-icon"
            viewBox="0 0 12 12"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
        <span role="status" className="visually-hidden">
          {collapsed ? t('panel.state.collapsed') : t('panel.state.expanded')}
        </span>
      </header>
      <div id={bodyId} className="panel-body" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
