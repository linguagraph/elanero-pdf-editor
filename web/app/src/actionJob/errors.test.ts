import { describe, expect, it } from 'vitest';
import { RpcError } from '../rpc/client';
import { isEncryptedRefusal, isSignedRefusal } from './errors';

describe('isSignedRefusal (W7.4 S2)', () => {
  it('is true only for a REFUSED with the signed_document reason', () => {
    expect(isSignedRefusal(new RpcError('REFUSED', 'x', { reason: 'signed_document' }))).toBe(true);
    expect(isSignedRefusal(new RpcError('REFUSED', 'x', { reason: 'encrypted_source' }))).toBe(
      false,
    );
    expect(isSignedRefusal(new RpcError('BUSY', 'x', { reason: 'signed_document' }))).toBe(false);
    expect(isSignedRefusal(new Error('signed_document'))).toBe(false);
  });

  it('does not match the encrypted refusal', () => {
    expect(isEncryptedRefusal(new RpcError('REFUSED', 'x', { reason: 'signed_document' }))).toBe(
      false,
    );
  });
});
