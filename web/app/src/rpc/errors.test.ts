import { describe, expect, it } from 'vitest';
import { EN } from '../i18n/en';
import { t } from '../i18n/t';
import { RpcError, type RpcErrorCode } from './client';
import { ERROR_CODES } from './generated';
import { actionLabelId, mapLoadFailure, mapRpcError } from './errors';

describe('mapRpcError', () => {
  it('maps every generated error code to a catalogue message and an action', () => {
    for (const code of ERROR_CODES) {
      const presented = mapRpcError(new RpcError(code, 'engine text'));
      expect(presented.messageId in EN, code).toBe(true);
      expect(EN[actionLabelId(presented.action)], code).toBeTruthy();
    }
  });

  it('maps a timeout to the restart-engine choice', () => {
    const presented = mapRpcError(new RpcError('TIMEOUT', 'slow'));
    expect(presented.messageId).toBe('error.TIMEOUT');
    expect(presented.action).toBe('restart engine');
  });

  it('asks for the password when one is required or wrong', () => {
    for (const code of ['PASSWORD_REQUIRED', 'WRONG_PASSWORD'] as const) {
      const presented = mapRpcError(new RpcError(code, 'x'));
      expect(presented.action).toBe('ask for password');
      expect(t(presented.messageId)).toMatch(/password/i);
    }
  });

  it('suggests saving as a new file after a failed signed in-place save', () => {
    const signed = mapRpcError(new RpcError('SAVE_FAILED', 'x'), { signedInPlaceSave: true });
    expect(signed.messageId).toBe('error.SAVE_FAILED.signed');
    expect(signed.action).toBe('save as a new file');
    expect(t(signed.messageId)).toMatch(/Save it as a new file/);

    const plain = mapRpcError(new RpcError('SAVE_FAILED', 'x'));
    expect(plain.messageId).toBe('error.SAVE_FAILED');
    expect(plain.action).toBe('retry');
  });

  it('gives an unknown code the generic message with no details', () => {
    const unknown = new RpcError(
      'SOMETHING_NEW' as unknown as RpcErrorCode,
      'Traceback at /home/user/secret.pdf',
      { path: '/home/user/secret.pdf' },
    );
    const presented = mapRpcError(unknown);
    expect(presented.messageId).toBe('error.UNKNOWN');
    expect(presented.params).toEqual({});
    const text = t(presented.messageId, presented.params);
    expect(text).toBe(EN['error.UNKNOWN']);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('SOMETHING_NEW');
  });

  it('states the size limit when details give it, and not otherwise', () => {
    const withLimit = mapRpcError(
      new RpcError('FILE_TOO_LARGE', 'x', { max_bytes: 50 * 1024 * 1024, size: 60_000_000 }),
    );
    expect(t(withLimit.messageId, withLimit.params)).toContain('limit 50 MB');

    const noLimit = mapRpcError(new RpcError('FILE_TOO_LARGE', 'x', {}));
    expect(noLimit.messageId).toBe('error.FILE_TOO_LARGE.noLimit');
  });

  it('marks a cancel as silent', () => {
    expect(mapRpcError(new RpcError('CANCELLED', 'x')).silent).toBe(true);
    expect(mapRpcError(new RpcError('BUSY', 'x')).silent).toBe(false);
  });
});

describe('mapLoadFailure', () => {
  it('names the message for each failed load stage', () => {
    for (const stage of ['pyodide', 'packages', 'engine'] as const) {
      const presented = mapLoadFailure(stage);
      expect(presented.messageId).toBe(`loading.failed.${stage}`);
      expect(presented.messageId in EN).toBe(true);
    }
  });
});
