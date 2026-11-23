// The translation consent (W6.6 section 7). Translation is off until the user agrees to the notice,
// and a changed notice (a higher NOTICE_VERSION) asks again. The record lives in the preferences,
// so Clear all local data removes it with the rest.
import { TRANSLATION_SERVICE, type Preferences } from '../prefs/store';
import type { TranslationInfoResult } from '../rpc/generated';

// Raise this when the notice's text changes, so every user is asked again.
export const NOTICE_VERSION = 1;

// Reads the service's languages and privacy link (translation.info); see the Preferences page.
export type TranslationInfoLoader = () => Promise<TranslationInfoResult>;

export type TranslationPrefs = Pick<Preferences, 'translationEnabled' | 'translationConsent'>;

// True when the record covers the current notice for the one service the web offers.
export function hasCurrentConsent(prefs: Pick<Preferences, 'translationConsent'>): boolean {
  const record = prefs.translationConsent;
  return (
    record !== null && record.service === TRANSLATION_SERVICE && record.version === NOTICE_VERSION
  );
}

// What agreeing to the notice saves: translation on, and the record with the time it was given.
export function agreedPatch(now: Date = new Date()): TranslationPrefs {
  return {
    translationEnabled: true,
    translationConsent: {
      service: TRANSLATION_SERVICE,
      version: NOTICE_VERSION,
      at: now.toISOString(),
    },
  };
}

// Turning translation off clears the record, so the notice asks again the next time it is turned on.
export function withdrawnPatch(): TranslationPrefs {
  return { translationEnabled: false, translationConsent: null };
}
