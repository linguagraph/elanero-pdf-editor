// The pure logic of the Redaction Properties dialog (W4.14): the style of new marks, held in the
// local preferences. Nothing here touches the document; the dialog only writes the three style keys.
import { hexToColorJson, type ColorJson } from '../prefs/colour';
import {
  cleanHexColour,
  cleanOverlayText,
  DEFAULT_PREFERENCES,
  OVERLAY_TEXT_MAX_LENGTH,
  type Preferences,
} from '../prefs/store';
import type { MarkStylePatch } from './marks';
import { colorInputValue } from './MarkStyleFields';

// The style draft the dialog edits. The overlay text is kept within the preferences' limit.
export interface MarkStyleDraft {
  readonly fill: ColorJson;
  readonly textColor: ColorJson;
  readonly overlayText: string;
}

// The three keys the dialog writes (the same keys the Preferences dialog's redaction section uses).
export type RedactionStyleKeys = Pick<
  Preferences,
  'redactionFill' | 'redactionOverlayText' | 'redactionTextColor'
>;

export function draftFromPreferences(prefs: RedactionStyleKeys): MarkStyleDraft {
  return {
    fill: hexToColorJson(cleanHexColour(prefs.redactionFill, DEFAULT_PREFERENCES.redactionFill)),
    textColor: hexToColorJson(
      cleanHexColour(prefs.redactionTextColor, DEFAULT_PREFERENCES.redactionTextColor),
    ),
    overlayText: cleanOverlayText(prefs.redactionOverlayText),
  };
}

// Applies one field change from MarkStyleFields. The overlay text is cut to the preferences' limit
// here as well, so no path can keep a longer text than the store would.
export function applyStylePatch(draft: MarkStyleDraft, patch: MarkStylePatch): MarkStyleDraft {
  return {
    fill: patch.fill ?? draft.fill,
    textColor: patch.textColor ?? draft.textColor,
    overlayText:
      patch.overlayText === undefined
        ? draft.overlayText
        : patch.overlayText.slice(0, OVERLAY_TEXT_MAX_LENGTH),
  };
}

// The keys to write for a draft. The colours go back to #rrggbb, the form the store keeps.
export function preferencesFromDraft(draft: MarkStyleDraft): RedactionStyleKeys {
  return {
    redactionFill: colorInputValue(draft.fill),
    redactionTextColor: colorInputValue(draft.textColor),
    redactionOverlayText: cleanOverlayText(draft.overlayText),
  };
}
