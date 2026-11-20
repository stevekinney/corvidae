/**
 * Pandoc's `tex_math_dollars` rule for inline math, applied before parsing.
 *
 * `remark-math` treats every `$…$` pair as math, so a price range such as
 * `$25–$100` renders `25–` as KaTeX. Pandoc's rule keeps `$x$` available and
 * leaves currency literal:
 *
 * - An opening `$` needs a non-space character immediately to its right.
 * - The first unescaped `$` after it must close the math: it needs a
 *   non-space character immediately to its left and must not be followed by a
 *   digit. If it cannot close, the opening `$` is literal.
 * - Runs of two or more dollars (`$$…$$` display math) are left alone.
 * - A backslash-escaped `\$` is never a delimiter.
 *
 * {@link analyzeDollarMath} finds every single `$` that cannot be a delimiter
 * and escapes it as `\$`, leaving fenced code, indented code, inline code spans
 * and URLs untouched. It also reports whether any math remains, so the
 * `probablyHasMath` probe and the parser read the same source and cannot
 * disagree. The escaped text is parse input only; callers keep the original
 * source as `rawMarkdown`.
 *
 * @module
 */

/** The result of scanning markdown for dollar-delimited math. */
export type DollarMathAnalysis = {
  /** The source with every non-delimiter single `$` escaped as `\$`. */
  source: string;
  /** Whether any `$$` run or valid `$…$` pair remains outside code. */
  hasMath: boolean;
};

const WHITESPACE = /\s/;
const DIGIT = /[0-9]/;
const BLANK_LINE = /^[ \t\r]*$/;
const CONTAINER_PREFIX = String.raw`(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*`;
const FENCE_OPENING = new RegExp(`^${CONTAINER_PREFIX}(\`{3,}|~{3,})(.*)$`);
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const AUTOLINK = /<[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>/y;
const BARE_URL = /https?:\/\/[^\s<]*/y;
const BLANK_LINE_AHEAD = /\n[ \t\r]*\n/y;

/** Does the closing fence for `fence` appear on this line? */
function closesFence(line: string, fence: string): boolean {
  const match = new RegExp(`^${CONTAINER_PREFIX}(\`{3,}|~{3,})[ \\t\\r]*$`).exec(line);
  const closing = match?.[1];
  return closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length;
}

/** Split lines into groups that are prose or code, each group joined by newlines. */
function groupLines(markdown: string): Array<{ code: boolean; text: string }> {
  const groups: Array<{ code: boolean; lines: string[] }> = [];
  const push = (code: boolean, line: string): void => {
    const last = groups.at(-1);
    if (last && last.code === code) last.lines.push(line);
    else groups.push({ code, lines: [line] });
  };

  let fence: string | null = null;
  let previousBlank = true;
  let previousWasIndentedCode = false;
  let inList = false;

  for (const line of markdown.split('\n')) {
    if (fence !== null) {
      push(true, line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const blank = BLANK_LINE.test(line);
    const opening = FENCE_OPENING.exec(line);
    if (opening && !(opening[1]!.startsWith('`') && opening[2]!.includes('`'))) {
      fence = opening[1]!;
      push(true, line);
      previousBlank = false;
      previousWasIndentedCode = false;
      continue;
    }

    if (
      !blank &&
      INDENTED_CODE.test(line) &&
      !inList &&
      (previousBlank || previousWasIndentedCode)
    ) {
      push(true, line);
      previousBlank = false;
      previousWasIndentedCode = true;
      continue;
    }

    if (!blank && !INDENTED_CODE.test(line)) inList = LIST_ITEM.test(line);
    push(false, line);
    previousBlank = blank;
    // A blank line between two indented code lines keeps the block going.
    previousWasIndentedCode = previousWasIndentedCode && blank;
  }

  return groups.map(({ code, lines }) => ({ code, text: lines.join('\n') }));
}

/** The index after the code span opening at `start`, or -1 when it never closes. */
function codeSpanEnd(text: string, start: number): number {
  let length = 1;
  while (text[start + length] === '`') length += 1;
  let cursor = start + length;
  while (cursor < text.length) {
    if (text[cursor] === '\n') {
      BLANK_LINE_AHEAD.lastIndex = cursor;
      if (BLANK_LINE_AHEAD.test(text)) return -1;
    }
    if (text[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    let run = 1;
    while (text[cursor + run] === '`') run += 1;
    if (run === length) return cursor + run;
    cursor += run;
  }
  return -1;
}

/**
 * The index of the `$` closing the math opened at `start`, or -1 when the
 * opening dollar is literal.
 */
function closingDollar(text: string, start: number): number {
  const first = text[start + 1];
  if (first === undefined || WHITESPACE.test(first)) return -1;

  let cursor = start + 1;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '\n') {
      BLANK_LINE_AHEAD.lastIndex = cursor;
      if (BLANK_LINE_AHEAD.test(text)) return -1;
    }
    if (character === '$') {
      const after = text[cursor + 1];
      const closes =
        !WHITESPACE.test(text[cursor - 1]!) &&
        (after === undefined || (after !== '$' && !DIGIT.test(after)));
      return closes ? cursor : -1;
    }
    cursor += 1;
  }
  return -1;
}

/** The length of the autolink or bare URL starting at `start`, or 0. */
function urlLength(text: string, start: number): number {
  const character = text[start];
  if (character === '<') {
    AUTOLINK.lastIndex = start;
    return AUTOLINK.exec(text)?.[0].length ?? 0;
  }
  if (character === 'h' && !/[A-Za-z0-9]/.test(text[start - 1] ?? ' ')) {
    BARE_URL.lastIndex = start;
    return BARE_URL.exec(text)?.[0].length ?? 0;
  }
  return 0;
}

/** Replace the non-delimiter dollars in one run of prose with `literalDollar`. */
function analyzeProse(text: string, literalDollar: string): DollarMathAnalysis {
  let output = '';
  let hasMath = false;
  let cursor = 0;

  while (cursor < text.length) {
    const character = text[cursor]!;

    if (character === '\\') {
      output += text.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }

    if (character === '`') {
      const end = codeSpanEnd(text, cursor);
      let length = 1;
      while (text[cursor + length] === '`') length += 1;
      const stop = end === -1 ? cursor + length : end;
      output += text.slice(cursor, stop);
      cursor = stop;
      continue;
    }

    const urlEnd = urlLength(text, cursor);
    if (urlEnd > 0) {
      output += text.slice(cursor, cursor + urlEnd);
      cursor += urlEnd;
      continue;
    }

    if (character !== '$') {
      output += character;
      cursor += 1;
      continue;
    }

    let run = 1;
    while (text[cursor + run] === '$') run += 1;
    if (run > 1) {
      hasMath = true;
      output += text.slice(cursor, cursor + run);
      cursor += run;
      continue;
    }

    const closing = closingDollar(text, cursor);
    if (closing === -1) {
      output += literalDollar;
      cursor += 1;
    } else {
      hasMath = true;
      output += text.slice(cursor, closing + 1);
      cursor = closing + 1;
    }
  }

  return { source: output, hasMath };
}

/**
 * Escape every single `$` that cannot delimit inline math under Pandoc's rule,
 * and report whether any math remains.
 *
 * A `$$` run counts as math without pairing it, which keeps the probe
 * conservative: a false positive loads the math chunk for nothing, a false
 * negative silently drops math.
 *
 * `literalDollar` replaces each non-delimiter `$`. The default `\$` changes
 * lengths; a caller that maps offsets back into the source passes a
 * single-character replacement so the result keeps the input's length.
 */
export function analyzeDollarMath(markdown: string, literalDollar = '\\$'): DollarMathAnalysis {
  if (!markdown.includes('$')) return { source: markdown, hasMath: false };

  let hasMath = false;
  const parts: string[] = [];
  for (const group of groupLines(markdown)) {
    if (group.code || !group.text.includes('$')) {
      parts.push(group.text);
      continue;
    }
    const prose = analyzeProse(group.text, literalDollar);
    hasMath ||= prose.hasMath;
    parts.push(prose.source);
  }
  return { source: parts.join('\n'), hasMath };
}
