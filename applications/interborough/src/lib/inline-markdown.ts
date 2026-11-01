/**
 * The inline Markdown a chat's title may carry: `code`, **bold** and *emphasis* (or `_emphasis_`),
 * and nothing else. A title is one line of text a person or the agent wrote, so a link, an image,
 * a heading marker or HTML stays the characters it was typed as; what this returns is a list of
 * runs that a component draws as elements, never markup that is injected. Text that opens a mark
 * and never closes it is left as typed.
 */

/** One run of a title: plain text, or text set in the mark that surrounded it. */
export type InlineRun = {
  /** The mark that surrounded the text, or `text` for none. */
  readonly kind: 'text' | 'strong' | 'emphasis' | 'code';
  /** The characters of the run, without the marks that surrounded them. */
  readonly text: string;
};

/** A mark and the text inside it. Emphasis with an underscore needs a word boundary on both sides. */
const MARKS =
  /`([^`]+)`|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)|\*(?=[^\s*])([^*]+?)(?<=\S)\*|(?<!\w)_(?=[^\s_])([^_]+?)(?<=\S)_(?!\w)/g;

/** Splits `source` into its runs, in order. An empty source has none. */
export function inlineRuns(source: string): readonly InlineRun[] {
  const runs: InlineRun[] = [];
  let cursor = 0;
  for (const match of source.matchAll(MARKS)) {
    if (match.index > cursor) runs.push({ kind: 'text', text: source.slice(cursor, match.index) });
    const [, code, starBold, underscoreBold, starEmphasis, underscoreEmphasis] = match;
    if (code !== undefined) runs.push({ kind: 'code', text: code });
    else if (starBold !== undefined || underscoreBold !== undefined)
      runs.push({ kind: 'strong', text: starBold ?? underscoreBold ?? '' });
    else runs.push({ kind: 'emphasis', text: starEmphasis ?? underscoreEmphasis ?? '' });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) runs.push({ kind: 'text', text: source.slice(cursor) });
  return runs;
}
