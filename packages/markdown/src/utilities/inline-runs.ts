/**
 * The inline Markdown of one line of text, as a list of runs: `code`, **strong** and *emphasis*,
 * each enabled by the profile a caller passes, and nothing else. A line is text a person or an
 * agent wrote (a chat's title, a setting's description), so a link, an image, a heading marker or
 * HTML stays the characters it was typed as; what this returns is runs a component draws as
 * elements, never markup that is injected. A mark that opens and never closes is left as typed.
 *
 * It imports nothing, so a browser bundle takes it without the rendering pipeline.
 */

/** One run of a line: plain text, or text set in the mark that surrounded it. */
export type InlineRun = {
  /** The mark that surrounded the text, or `text` for none. */
  readonly kind: 'text' | 'strong' | 'emphasis' | 'code';
  /** The characters of the run, without the marks that surrounded them. */
  readonly text: string;
};

/** Which marks a line reads, and what an empty code span becomes. */
export type InlineRunsProfile = {
  /** Whether a span between two backticks is a `code` run. */
  readonly code: boolean;
  /** Whether `**text**` (or `__text__` at word boundaries) is a `strong` run. */
  readonly strong: boolean;
  /** Whether `*text*` (or `_text_` at word boundaries) is an `emphasis` run. */
  readonly emphasis: boolean;
  /**
   * What two adjacent backticks become: `literal` leaves them as typed, `omitted` drops them and
   * leaves the text on either side as separate runs.
   */
  readonly emptyCodeSpan: 'literal' | 'omitted';
};

/** A chat's title: `code`, **bold** and *emphasis*. An empty code span stays as typed. */
export const TITLE_INLINE_RUNS_PROFILE: InlineRunsProfile = Object.freeze({
  code: true,
  strong: true,
  emphasis: true,
  emptyCodeSpan: 'literal',
});

/** A setting's description: `code` spans only. An empty code span is dropped. */
export const DESCRIPTION_INLINE_RUNS_PROFILE: InlineRunsProfile = Object.freeze({
  code: true,
  strong: false,
  emphasis: false,
  emptyCodeSpan: 'omitted',
});

/**
 * The pattern of each mark, tried in this order at every position. Underscore marks need a word
 * boundary on both sides, so `snake_case_name` is text.
 */
const strongPatterns = [
  ['starStrong', '\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*'],
  ['underscoreStrong', '(?<!\\w)__(?=\\S)(.+?)(?<=\\S)__(?!\\w)'],
] as const;
const emphasisPatterns = [
  ['starEmphasis', '\\*(?=[^\\s*])([^*]+?)(?<=\\S)\\*'],
  ['underscoreEmphasis', '(?<!\\w)_(?=[^\\s_])([^_]+?)(?<=\\S)_(?!\\w)'],
] as const;

type MarkGroup = (typeof strongPatterns | typeof emphasisPatterns)[number][0];
type Matcher = { readonly pattern: RegExp; readonly groups: readonly (MarkGroup | 'code')[] };

const matchers = new Map<string, Matcher | null>();

/** The matcher for `profile`, or `null` when it enables no mark. */
function matcherFor(profile: InlineRunsProfile): Matcher | null {
  const key = `${profile.code}|${profile.strong}|${profile.emphasis}|${profile.emptyCodeSpan}`;
  const cached = matchers.get(key);
  if (cached !== undefined) return cached;

  const alternatives: string[] = [];
  const groups: (MarkGroup | 'code')[] = [];
  if (profile.code) {
    alternatives.push(profile.emptyCodeSpan === 'omitted' ? '`([^`]*)`' : '`([^`]+)`');
    groups.push('code');
  }
  const marks = [
    ...(profile.strong ? strongPatterns : []),
    ...(profile.emphasis ? emphasisPatterns : []),
  ];
  for (const [group, pattern] of marks) {
    alternatives.push(pattern);
    groups.push(group);
  }
  const matcher =
    alternatives.length === 0 ? null : { pattern: new RegExp(alternatives.join('|'), 'g'), groups };
  matchers.set(key, matcher);
  return matcher;
}

/**
 * Splits `source` into its runs, in order, reading the marks `profile` enables. An empty source
 * has none. The text between two marks is one run; a dropped empty code span leaves the text on
 * either side of it as two runs.
 */
export function inlineRuns(source: string, profile: InlineRunsProfile): readonly InlineRun[] {
  const matcher = matcherFor(profile);
  if (matcher === null) return source.length === 0 ? [] : [{ kind: 'text', text: source }];

  const runs: InlineRun[] = [];
  let cursor = 0;
  for (const match of source.matchAll(matcher.pattern)) {
    if (match.index > cursor) runs.push({ kind: 'text', text: source.slice(cursor, match.index) });
    // The captures are in the order of `groups`; the one that took part names the mark.
    const captured = matcher.groups.findIndex((_, index) => match[index + 1] !== undefined);
    const group = matcher.groups[captured];
    const text = match[captured + 1] ?? '';
    // An empty span only matches under `omitted`, and leaves no run.
    if (group === 'code') {
      if (text.length > 0) runs.push({ kind: 'code', text });
    } else if (group === 'starStrong' || group === 'underscoreStrong')
      runs.push({ kind: 'strong', text });
    else runs.push({ kind: 'emphasis', text });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) runs.push({ kind: 'text', text: source.slice(cursor) });
  return runs;
}
