import { describe, expect, it } from 'vitest';
import { CSP_POLICY } from '../csp';
import {
  TRANSLATION_METHODS,
  TRANSLATION_ORIGINS,
  createTranslationNet,
  isTranslationUrl,
  type XhrLike,
} from './translationNet';

// A stand-in for the browser's XMLHttpRequest that records what it is asked to do.
class FakeNative implements XhrLike {
  static opened: unknown[][] = [];
  static calls: unknown[][] = [];
  status = 200;
  responseText = '{}';
  timeout = 0;
  withCredentials = true;
  open(method: string, url: string, asynchronous: boolean): void {
    FakeNative.opened.push([method, url, asynchronous]);
  }
  setRequestHeader(name: string, value: string): void {
    FakeNative.calls.push(['setRequestHeader', name, value]);
  }
  send(body?: string): void {
    FakeNative.calls.push(['send', body, this.withCredentials]);
  }
}

function gate() {
  FakeNative.opened = [];
  FakeNative.calls = [];
  return createTranslationNet(FakeNative);
}

describe('translation gate (W6.6 section 3)', () => {
  it('refuses to open a request unless it is armed', () => {
    const net = gate();
    expect(() => net.openXhr()).toThrow(/not allowed/);
    expect(() => net.openXhr().open('GET', 'https://libretranslate.com/translate', false)).toThrow(
      /not allowed/,
    );
    expect(FakeNative.opened).toEqual([]);
  });

  it('gives Python no constructor that reaches the native class', () => {
    const net = gate();
    net.arm();
    const xhr = net.openXhr() as unknown as object;
    // Walk the object's prototype chain and the chain of its constructor property.
    const reaches = (start: unknown): boolean => {
      for (let o: unknown = start; o !== null && o !== undefined; o = Object.getPrototypeOf(o)) {
        if (o === FakeNative || o === FakeNative.prototype) return true;
        if ((o as { name?: unknown }).name === 'XMLHttpRequest') return true;
      }
      return false;
    };
    const ctor = (xhr as { constructor: unknown }).constructor;
    expect(reaches(xhr)).toBe(false);
    expect(reaches(ctor)).toBe(false);
    expect(ctor).not.toBe(FakeNative);
    expect(FakeNative.opened).toEqual([]);
  });

  it('refuses a request to a host outside the list, even when armed', () => {
    const net = gate();
    net.arm();
    expect(() => net.openXhr().open('GET', 'https://api.deepl.com/v2/translate', false)).toThrow(
      /host not allowed/,
    );
    expect(FakeNative.opened).toEqual([]);
  });

  it('keeps the request methods working for an allowed origin', () => {
    const net = gate();
    net.arm();
    const xhr = net.openXhr();
    xhr.timeout = 5000;
    xhr.withCredentials = true;
    xhr.open('POST', 'https://libretranslate.com/translate', false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send('{"q":"hi"}');
    expect(xhr.timeout).toBe(5000);
    expect(xhr.status).toBe(200);
    expect(xhr.responseText).toBe('{}');
    expect(FakeNative.opened).toEqual([['POST', 'https://libretranslate.com/translate', false]]);
    expect(FakeNative.calls).toEqual([
      ['setRequestHeader', 'Content-Type', 'application/json'],
      ['send', '{"q":"hi"}', false],
    ]);
  });

  it('allows the three translation hosts when armed, and sends no credentials', () => {
    const net = gate();
    net.arm();
    for (const origin of TRANSLATION_ORIGINS) {
      const xhr = net.openXhr();
      xhr.open('GET', `${origin}/x`, false);
      expect(xhr.withCredentials).toBe(false);
    }
    expect(FakeNative.opened.map((call) => call[1])).toEqual(
      TRANSLATION_ORIGINS.map((origin) => `${origin}/x`),
    );
    expect(FakeNative.opened.every((call) => call[2] === false)).toBe(true);
  });

  it('refuses other hosts, plain http, look-alikes, user-info and asynchronous requests', () => {
    const net = gate();
    net.arm();
    const refused = [
      'https://example.test/get',
      'http://libretranslate.com/translate',
      'https://libretranslate.com.example.test/translate',
      'https://libretranslate.com@example.test/translate',
      'https://user:pw@libretranslate.com/translate',
      'https://api.deepl.com/v2/translate',
      'not a url',
    ];
    for (const url of refused) {
      expect(() => net.openXhr().open('GET', url, false), url).toThrow();
    }
    expect(() => net.openXhr().open('GET', 'https://libretranslate.com/', true)).toThrow(
      /synchronous/,
    );
    expect(() => net.openXhr().open('PUT', 'https://libretranslate.com/', false)).toThrow(/method/);
    expect(FakeNative.opened).toEqual([]);
  });

  it('closes again on disarm, and a request already open stops at its next call', () => {
    const net = gate();
    net.arm();
    const xhr = net.openXhr();
    xhr.open('POST', 'https://libretranslate.com/translate', false);
    net.disarm();
    expect(() => xhr.setRequestHeader('Content-Type', 'application/json')).toThrow();
    expect(() => xhr.send('{}')).toThrow();
    expect(() => net.openXhr().open('GET', 'https://libretranslate.com/', false)).toThrow();
  });

  it('has no native constructor when the worker captured none', () => {
    const net = createTranslationNet(undefined);
    net.arm();
    expect(() => net.openXhr()).toThrow(/not available/);
  });

  it('is armed only for the translation calls', () => {
    expect([...TRANSLATION_METHODS].sort()).toEqual(['translation.test', 'translation.translate']);
  });
});

describe('translation hosts', () => {
  it('equal the connect-src hosts of the CSP, minus self', () => {
    const connect = CSP_POLICY.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('connect-src'));
    const hosts = (connect ?? '')
      .split(' ')
      .slice(1)
      .filter((token) => token !== "'self'");
    expect([...TRANSLATION_ORIGINS].sort()).toEqual([...hosts].sort());
  });

  it('accepts only https origins on the list', () => {
    expect(isTranslationUrl('https://libretranslate.com/translate?x=1')).toBe(true);
    expect(isTranslationUrl('https://libretranslate.com:443/translate')).toBe(true);
    expect(isTranslationUrl('https://libretranslate.co/translate')).toBe(false);
  });
});
