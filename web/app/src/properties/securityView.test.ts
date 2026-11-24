// The Security tab's labels and permission rows (W7.6 slice C): every method has a label, and the
// rows are the eight permissions in one fixed order, each with its own allowed state.
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import type { EncryptionMethod, Permissions } from '../rpc/generated';
import { methodLabel, PERMISSION_ORDER, permissionRows } from './securityView';

const everything: Permissions = {
  print: true,
  modify: false,
  copy: false,
  annotate: true,
  fill_forms: false,
  accessibility: true,
  assemble: false,
  print_high_quality: true,
};

describe('methodLabel', () => {
  it('names every method the engine reports', () => {
    const methods: EncryptionMethod[] = [
      'none',
      'rc4-40',
      'rc4-128',
      'aes-128',
      'aes-256',
      'unknown',
    ];
    const labels = methods.map((method) => t(methodLabel(method)));
    expect(labels).toEqual([
      'No security',
      'RC4 40-bit',
      'RC4 128-bit',
      'AES-128',
      'AES-256',
      'Unknown method',
    ]);
  });
});

describe('permissionRows', () => {
  it('lists all eight permissions in a fixed order with their state', () => {
    const rows = permissionRows(everything);
    expect(rows.map((row) => row.key)).toEqual([
      'print',
      'modify',
      'copy',
      'annotate',
      'fill_forms',
      'assemble',
      'accessibility',
      'print_high_quality',
    ]);
    expect(PERMISSION_ORDER).toHaveLength(8);
    expect(rows.map((row) => row.allowed)).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      true,
    ]);
  });

  it('gives each row a translated label', () => {
    const labels = permissionRows(everything).map((row) => t(row.label));
    expect(new Set(labels).size).toBe(8);
    expect(labels).toContain('High-quality printing');
    expect(labels).toContain('Content for accessibility tools');
  });
});
