// The Security tab of the document properties (W7.6): a read-only view of session.security. The
// panel never takes a password and has no buttons; changing the security stays in the Encrypt and
// Remove Security commands, which the hint names. PropertiesDialog reads the state when the tab is
// first shown.
import { Fragment } from 'react';
import { t } from '../i18n/t';
import type { SecurityResult } from '../rpc/generated';
import { yesNo } from './facts';
import { methodLabel, permissionRows } from './securityView';

export type SecurityTabState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly state: SecurityResult };

export interface SecurityPanelProps {
  state: SecurityTabState;
}

export function SecurityPanel({ state }: SecurityPanelProps) {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <p className="properties-hint" role="status">
        {t('properties.security.loading')}
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <p className="properties-message" role="alert">
        {t('properties.security.failed')}
      </p>
    );
  }
  return <SecurityView security={state.state} />;
}

// The line for a change queued for the next save, or null when none is queued.
function pendingLine(security: SecurityResult): string | null {
  if (security.pending === 'remove') return t('properties.security.pendingRemove');
  if (security.pending === 'encrypt' && security.pending_method !== null) {
    return t('properties.security.pendingSet', {
      method: t(methodLabel(security.pending_method)),
    });
  }
  return null;
}

function SecurityView({ security }: { security: SecurityResult }) {
  const encrypted = security.encryption !== 'none';
  const pending = pendingLine(security);
  return (
    <>
      <dl className="properties-readonly">
        <dt>{t('properties.security.method')}</dt>
        <dd>{t(methodLabel(security.encryption))}</dd>
        {encrypted
          ? permissionRows(security.permissions).map((row) => (
              <Fragment key={row.key}>
                <dt>{t(row.label)}</dt>
                <dd>
                  {t(
                    row.allowed ? 'properties.security.allowed' : 'properties.security.notAllowed',
                  )}
                </dd>
              </Fragment>
            ))
          : null}
        {encrypted ? (
          <>
            <dt>{t('properties.security.ownerAccess')}</dt>
            <dd>{yesNo(security.owner_access)}</dd>
          </>
        ) : null}
      </dl>
      {encrypted && security.owner_access ? (
        <p className="properties-hint">{t('properties.security.ownerNote')}</p>
      ) : null}
      {pending === null ? null : (
        <p className="properties-hint" role="status">
          {pending}
        </p>
      )}
      <p className="properties-hint">{t('properties.security.hint')}</p>
    </>
  );
}
