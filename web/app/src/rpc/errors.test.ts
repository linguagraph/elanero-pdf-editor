import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN } from '../i18n/en';
import { t } from '../i18n/t';
import { RpcError, type RpcErrorCode } from './client';
import { ERROR_CODES } from './generated';
import { actionLabelId, mapLoadFailure, mapRpcError, REFUSED_REASON, TABLE } from './errors';

const MEBIBYTE = 1024 * 1024;
const NONE: ReadonlyArray<Record<string, unknown>> = [{}];

// The details the engine sends for each code (webapi/*.py), one list per code. `{}` is a reply
// with no details. Every sample gets a `secret` value that must never reach the message text.
const DETAIL_SAMPLES: Record<RpcErrorCode, ReadonlyArray<Record<string, unknown>>> = {
  INVALID_REQUEST: NONE,
  INVALID_ARGS: [{}, { path: 'args.max_bytes' }],
  INVALID_FONT: NONE,
  FONT_NOT_EMBEDDABLE: NONE,
  PROTOCOL_MISMATCH: NONE,
  NO_DOCUMENT: NONE,
  PASSWORD_REQUIRED: NONE,
  WRONG_PASSWORD: NONE,
  OPEN_FAILED: NONE,
  SAVE_FAILED: NONE,
  REFUSED: [
    {},
    { reason: 'encrypted_source' },
    { reason: 'encrypted_mutating_job' },
    { reason: 'encrypted_reduce' },
    { reason: 'document changed' },
    { reason: 'x y' },
  ],
  BUSY: [{}, { task: 'OCR' }],
  NOT_SUPPORTED: NONE,
  STALE_OBJECT: NONE,
  STALE_CURSOR: NONE,
  STALE_JOB: NONE,
  CANCELLED: NONE,
  FILE_TOO_LARGE: [
    {},
    { max_bytes: 50 * MEBIBYTE, size: 60_000_000 },
    { max_bytes: 2.5 * MEBIBYTE, size: 3_000_000 },
    { max_bytes: 0, size: 1 },
  ],
  TOO_MANY_PAGES: [{}, { max_pages: 5000, pages: 6000 }],
  RENDER_TOO_LARGE: [{}, { max_pixels: 1, pixels: 2 }],
  IMAGE_TOO_LARGE: [{}, { max_pixels: 1, pixels: 2 }],
  OUT_OF_MEMORY: NONE,
  ENGINE_ERROR: NONE,
  TRANSLATION_OFFLINE: NONE,
  TRANSLATION_QUOTA: NONE,
  TRANSLATION_AUTH: NONE,
  TRANSLATION_CONFIG: NONE,
  TRANSLATION_TOO_LONG: NONE,
  TRANSLATION_SAME_LANGUAGE: NONE,
  TRANSLATION_SERVICE: NONE,
  INTERNAL: NONE,
  TIMEOUT: NONE,
};

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
      new RpcError('FILE_TOO_LARGE', 'x', { max_bytes: 50 * MEBIBYTE, size: 60_000_000 }),
    );
    expect(withLimit.messageId).toBe('error.FILE_TOO_LARGE.limit');
    expect(t(withLimit.messageId, withLimit.params)).toContain('limit 50 MB');

    const noLimit = mapRpcError(new RpcError('FILE_TOO_LARGE', 'x', {}));
    expect(noLimit.messageId).toBe('error.FILE_TOO_LARGE');
    expect(noLimit.params).toEqual({});
  });

  it('formats the page limit with the grouping of the locale', () => {
    const presented = mapRpcError(new RpcError('TOO_MANY_PAGES', 'x', { max_pages: 5000 }));
    expect(presented.messageId).toBe('error.TOO_MANY_PAGES.limit');
    expect(t(presented.messageId, presented.params)).toContain('5,000');
    expect(mapRpcError(new RpcError('TOO_MANY_PAGES', 'x', {})).messageId).toBe(
      'error.TOO_MANY_PAGES',
    );
  });

  it('gives each known REFUSED reason its own message, and an unknown one the plain message', () => {
    for (const [reason, messageId] of Object.entries(REFUSED_REASON)) {
      expect(mapRpcError(new RpcError('REFUSED', 'x', { reason })).messageId, reason).toBe(
        messageId,
      );
    }
    const unknown = mapRpcError(new RpcError('REFUSED', 'x', { reason: 'x y' }));
    expect(unknown.messageId).toBe('error.REFUSED');
    expect(unknown.action).toBe('dismiss');
  });

  it('marks a cancel as silent', () => {
    expect(mapRpcError(new RpcError('CANCELLED', 'x')).silent).toBe(true);
    expect(mapRpcError(new RpcError('BUSY', 'x')).silent).toBe(false);
  });
});

describe('error coverage', () => {
  const SECRET = 'SECRET-SENTINEL';
  const codes = [...ERROR_CODES, 'TIMEOUT'] as RpcErrorCode[];

  it('has a table row and detail samples for every code', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(DETAIL_SAMPLES[code].length, code).toBeGreaterThan(0);
    }
  });

  it('fills every placeholder, and shows no detail text, for every code and sample', () => {
    for (const code of codes) {
      for (const sample of DETAIL_SAMPLES[code]) {
        const where = `${code} ${JSON.stringify(sample)}`;
        const presented = mapRpcError(new RpcError(code, SECRET, { ...sample, secret: SECRET }));
        const text = t(presented.messageId, presented.params);
        expect(typeof EN[presented.messageId], where).toBe('string');
        expect(EN[actionLabelId(presented.action)], where).toBeTruthy();
        expect(text, where).not.toMatch(/\{\w+\}/);
        expect(text, where).not.toContain(SECRET);
      }
    }
  });

  it('names only REFUSED reasons that the engine sends', () => {
    // web/app/src/rpc -> the repo root is four levels up.
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../src/pdfeditor/webapi');
    const source = readdirSync(dir)
      .filter((file) => file.endsWith('.py'))
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');
    for (const reason of Object.keys(REFUSED_REASON)) {
      expect(source, reason).toContain(`"reason": "${reason}"`);
    }
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
