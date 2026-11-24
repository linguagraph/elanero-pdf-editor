// The size limits that the web client and the engine both enforce (W8.6 F12 b). The engine is
// Python and the client is TypeScript, so each pair is written twice and nothing else keeps them
// equal. This test reads the source text of both sides, parses the constants, and fails on drift,
// printing both values. It does not import the Python files, so it runs without the engine.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_XFDF_BYTES as CLIENT_XFDF_BYTES } from './commentsImport/xfdfImport';
import { MAX_FILE_BYTES as CLIENT_FILE_BYTES } from './documents/openFile';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function source(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), 'utf8');
}

// Evaluates the integer arithmetic these constants use: `1024 ** 3`, `8 * 1024 * 1024`, and the
// same with underscores (Python). Anything else is refused, so a new form fails loudly. The regex
// accepts only well-formed sums of products and powers, so `1+`, `*` or `1**` throw too.
const SIMPLE_CONSTANT = /^\d+(\*{1,2}\d+)*(\+\d+(\*{1,2}\d+)*)*$/;

function evalConstant(expr: string): number {
  const compact = expr.replace(/[\s_]/g, '');
  if (!SIMPLE_CONSTANT.test(compact)) throw new Error(`unsupported constant expression: ${expr}`);
  const power = (factor: string): number =>
    factor
      .split('**')
      .map(Number)
      .reduceRight((exponent, base) => base ** exponent);
  const value = compact
    .split('+')
    .reduce(
      (sum, term) =>
        sum + term.split(/(?<!\*)\*(?!\*)/).reduce((product, factor) => product * power(factor), 1),
      0,
    );
  if (!Number.isSafeInteger(value)) throw new Error(`constant out of safe integer range: ${expr}`);
  return value;
}

// The right-hand side of `NAME = value`, from Python (`#` comment) or TypeScript (`;` end).
function constantIn(text: string, name: string, end: 'python' | 'typescript'): number {
  const pattern =
    end === 'python'
      ? new RegExp(`^${name}\\s*=\\s*([^#\\n]+?)\\s*(?:#.*)?$`, 'm')
      : new RegExp(`^export const ${name}\\s*=\\s*([^;\\n]+?)\\s*;`, 'm');
  const match = pattern.exec(text);
  if (!match?.[1]) throw new Error(`constant ${name} not found`);
  return evalConstant(match[1]);
}

describe('limits shared by the web client and the engine', () => {
  it('the client file limit equals the engine FILE_REFUSE_BYTES', async () => {
    const engine = constantIn(
      await source('src/pdfeditor/webapi/limits.py'),
      'FILE_REFUSE_BYTES',
      'python',
    );
    const client = constantIn(
      await source('web/app/src/documents/openFile.ts'),
      'MAX_FILE_BYTES',
      'typescript',
    );
    expect(
      CLIENT_FILE_BYTES,
      `engine FILE_REFUSE_BYTES=${engine}, client MAX_FILE_BYTES=${client}`,
    ).toBe(engine);
    expect(client).toBe(engine);
  });

  it('the client XFDF limit equals the engine MAX_XFDF_BYTES', async () => {
    const engine = constantIn(
      await source('src/pdfeditor/services/xfdf.py'),
      'MAX_XFDF_BYTES',
      'python',
    );
    const client = constantIn(
      await source('web/app/src/commentsImport/xfdfImport.ts'),
      'MAX_XFDF_BYTES',
      'typescript',
    );
    expect(
      CLIENT_XFDF_BYTES,
      `engine MAX_XFDF_BYTES=${engine}, client MAX_XFDF_BYTES=${client}`,
    ).toBe(engine);
    expect(client).toBe(engine);
  });

  it('parses the expressions it relies on', () => {
    expect(evalConstant('1024**3')).toBe(1024 ** 3);
    expect(evalConstant('1024 ** 3')).toBe(1024 ** 3);
    expect(evalConstant('8 * 1024 * 1024')).toBe(8 * 1024 * 1024);
    expect(() => evalConstant('max(1, 2)')).toThrow(/unsupported/);
  });
});
