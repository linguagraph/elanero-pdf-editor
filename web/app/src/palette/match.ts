// The command palette's fuzzy matcher (W4.3b). Pure: no DOM and no storage, so it runs headless and
// in tests. A query matches a command when every one of its words matches the command's label
// (or, at half weight, its search keywords). The ranking is the desktop's "starts with" idea,
// widened: a word match at the start of a label word beats a substring, which beats initials,
// which beat letters in order.
import { type CommandDef, type CommandState, type Registry } from '../commands/registry';
import { isVisible } from '../commands/run';
import { t } from '../i18n/t';

export interface PaletteMatch {
  readonly def: CommandDef;
  // Higher is better; 0 when the query is empty.
  readonly score: number;
  // 0 is the most recent command; Infinity when the command is not in the recent list.
  readonly recentRank: number;
}

// A label that starts with the whole query is worth more than the word hits alone, so "Save"
// outranks "Export Save" for "save".
const PREFIX_BONUS = 5;
// A keyword hit is an alias, so it counts for less than the same hit on the label.
const KEYWORD_FACTOR = 0.5;

// Tiers for one query word against one text (higher is a better match).
const TIER_WORD_START = 4;
const TIER_SUBSTRING = 3;
const TIER_INITIALS = 2;
const TIER_LETTERS_IN_ORDER = 1;

// Lower case, accents removed. The ellipsis, ampersand and punctuation become spaces, so "Open…"
// is "open" and "Fish & Chips" is two words. Idempotent, so a normalized text can be normalized
// again.
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whether `word` can be found by taking letters in order from `text`, with the first letter at the
// start of a word. A letters-in-order match on a short word matches nearly everything, so the
// caller only asks for words of 3 or more characters.
function lettersInOrderFromWordStart(text: string, word: string): boolean {
  for (let start = 0; start < text.length; start += 1) {
    const atWordStart = start === 0 || text[start - 1] === ' ';
    if (!atWordStart || text[start] !== word[0]) continue;
    let position = start + 1;
    let matched = true;
    for (let i = 1; i < word.length; i += 1) {
      const found = text.indexOf(word[i] ?? '', position);
      if (found === -1) {
        matched = false;
        break;
      }
      position = found + 1;
    }
    if (matched) return true;
  }
  return false;
}

// The tier (0 when no match) of one normalized word against one text. Both arguments are
// normalized here, so callers can pass labels and keywords as they are.
export function scoreLabel(label: string, word: string): number {
  const text = normalize(label);
  const needle = normalize(word);
  if (needle === '' || text === '') return 0;
  const parts = text.split(' ');
  if (parts.some((part) => part.startsWith(needle))) return TIER_WORD_START;
  if (text.includes(needle)) return TIER_SUBSTRING;
  const initials = parts.map((part) => part[0] ?? '').join('');
  if (needle.length >= 2 && initials.startsWith(needle)) return TIER_INITIALS;
  if (needle.length >= 3 && lettersInOrderFromWordStart(text, needle)) {
    return TIER_LETTERS_IN_ORDER;
  }
  return 0;
}

// Ascending comparison that also orders Infinity (a subtraction would give NaN).
function compareAscending(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// The visible commands that match every word of the query, best first. Ties keep the recent
// order (`recent` is newest first) and then the registry order. An empty query lists every
// visible command: the recent ones first, then the rest in registry order. Disabled commands
// are returned too, so the caller can show why they cannot run.
export function rankCommands(
  registry: Registry,
  state: CommandState,
  query: string,
  recent: readonly string[],
): PaletteMatch[] {
  const words = normalize(query)
    .split(' ')
    .filter((word) => word !== '');
  const whole = words.join(' ');
  const matches: PaletteMatch[] = [];
  for (const def of registry.commands) {
    if (!isVisible(def, state)) continue;
    let score = 0;
    let everyWordMatches = true;
    for (const word of words) {
      const label = scoreLabel(t(def.labelId), word);
      const keywords =
        def.keywordsId === undefined ? 0 : scoreLabel(t(def.keywordsId), word) * KEYWORD_FACTOR;
      const best = Math.max(label, keywords);
      if (best === 0) {
        everyWordMatches = false;
        break;
      }
      score += best;
    }
    if (!everyWordMatches) continue;
    if (whole !== '' && normalize(t(def.labelId)).startsWith(whole)) score += PREFIX_BONUS;
    const recentIndex = recent.indexOf(def.id);
    const recentRank = recentIndex === -1 ? Infinity : recentIndex;
    matches.push({ def, score, recentRank });
  }
  // Array.prototype.sort is stable, so equal rows keep the registry order.
  return matches.sort(
    (a, b) => compareAscending(b.score, a.score) || compareAscending(a.recentRank, b.recentRank),
  );
}
