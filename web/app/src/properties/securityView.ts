// How the Security tab of the document properties shows the security state (W7.6): the method
// label and the eight permission rows. Unlike the desktop, which lists only the allowed ones, every
// permission gets Allowed or Not allowed, so a fully refused file is not an empty list.
import type { MessageId } from '../i18n/en';
import type { EncryptionMethod, Permissions } from '../rpc/generated';

export type PermissionKey = keyof Permissions;

// The order of the rows: the desktop's six first, then the two it does not list.
export const PERMISSION_ORDER: readonly PermissionKey[] = [
  'print',
  'modify',
  'copy',
  'annotate',
  'fill_forms',
  'assemble',
  'accessibility',
  'print_high_quality',
];

const PERMISSION_LABEL: Readonly<Record<PermissionKey, MessageId>> = {
  print: 'security.perm.print',
  modify: 'security.perm.modify',
  copy: 'security.perm.copy',
  annotate: 'security.perm.annotate',
  fill_forms: 'security.perm.fill_forms',
  assemble: 'security.perm.assemble',
  accessibility: 'properties.security.perm.accessibility',
  print_high_quality: 'properties.security.perm.print_high_quality',
};

export interface PermissionRow {
  readonly key: PermissionKey;
  readonly label: MessageId;
  readonly allowed: boolean;
}

export function methodLabel(method: EncryptionMethod): MessageId {
  switch (method) {
    case 'none':
      return 'properties.security.none';
    case 'aes-256':
      return 'security.method.aes-256';
    case 'aes-128':
      return 'security.method.aes-128';
    case 'rc4-128':
      return 'properties.security.method.rc4-128';
    case 'rc4-40':
      return 'properties.security.method.rc4-40';
    case 'unknown':
      return 'properties.security.method.unknown';
  }
}

export function permissionRows(permissions: Permissions): PermissionRow[] {
  return PERMISSION_ORDER.map((key) => ({
    key,
    label: PERMISSION_LABEL[key],
    allowed: permissions[key],
  }));
}
