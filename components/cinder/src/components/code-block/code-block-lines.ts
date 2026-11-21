/**
 * Line numbers and notes for highlighted code.
 *
 * A highlighter hands CodeBlock one HTML string, so the block cannot number its lines while it
 * renders them. After the string is in the document this module finds the line elements the
 * highlighter drew (Shiki wraps each line in `<span class="line">`), marks them as CodeBlock lines
 * so one stylesheet numbers plain and highlighted code alike, and inserts each note after its line.
 */
import type { Attachment } from 'svelte/attachments';
import type { CodeBlockAnnotation, CodeBlockAnnotationTone } from './code-block.types.ts';

const svgNamespace = 'http://www.w3.org/2000/svg';

/** The icon paths for each tone: a triangle for a problem, a circled letter for information. */
const glyphs: Record<CodeBlockAnnotationTone, readonly string[]> = {
  danger: [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ],
  warning: [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
};

/** The class a token takes when its text is a numeric literal. */
export const numberTokenClass = 'cinder-code-block__number';

/** A number as a source file writes it: optional sign, digits with a point, an exponent. */
const numericLiteral = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * An attachment that tags the tokens of highlighted code that are numeric literals.
 *
 * A Shiki theme paints a number in the hue it uses for JSON keys, booleans and `null`, so a value
 * never reads as one class of its own. A token carries only an inline color, and a stylesheet
 * cannot read its text, so the text is read here and the token marked; the stylesheet then gives a
 * marked token the number role in dark mode. Only a token that holds nothing but the number is
 * marked, so a string, a comment or an identifier that merely contains digits never is.
 */
export const markNumericTokens: Attachment<HTMLElement> = (container) => {
  const marked: HTMLElement[] = [];
  for (const token of container.querySelectorAll<HTMLElement>('pre code span[style]')) {
    if (token.childElementCount > 0 || token.classList.contains('line')) continue;
    if (!numericLiteral.test(token.textContent.trim())) continue;
    token.classList.add(numberTokenClass);
    marked.push(token);
  }
  return () => {
    for (const token of marked) token.classList.remove(numberTokenClass);
  };
};

/** A command-line flag: one or two hyphens that start a word, then the flag's name. */
const flagPattern = /(?<![\w-])-{1,2}[A-Za-z][\w-]*/g;

/** The class a flag takes so a wrapping block keeps it on one line. */
export const flagClass = 'cinder-code-block__flag';

/**
 * Cuts `text` into runs of plain text and flags. A browser may break a line after a hyphen, so
 * `--notify` can end one line in `--` and begin the next with `notify`; the caller draws each flag
 * in an element that never breaks. The runs joined are exactly `text`.
 */
export function splitFlags(text: string): { text: string; flag: boolean }[] {
  const runs: { text: string; flag: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(flagPattern)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index), flag: false });
    runs.push({ text: match[0], flag: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), flag: false });
  return runs;
}

/**
 * Highlighted code is fresh DOM, so its text nodes can be cut: each flag is wrapped in its own
 * element, and the copied text is unchanged. A token the highlighter splits across two elements is
 * left alone.
 */
export const keepFlagsWhole: Attachment<HTMLElement> = (container) => {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) nodes.push(node);
  }
  for (const node of nodes) {
    const runs = splitFlags(node.data);
    if (!runs.some((run) => run.flag)) continue;
    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      if (!run.flag) {
        fragment.append(run.text);
        continue;
      }
      const flag = document.createElement('span');
      flag.className = flagClass;
      flag.textContent = run.text;
      fragment.append(flag);
    }
    node.replaceWith(fragment);
  }
};

/** The characters a wrapping block may break after (whitespace is a place to break of its own). */
const BREAK_AFTER = new Set(['/', '.', ':', '-', '"']);

/** The punctuation a break never falls in front of: it stays with the character before it. */
const NEVER_BEFORE = new Set(['/', '.', ':', '-', '"', ',', ';', ')', ']', '}']);

const isSpace = (character: string | undefined): boolean =>
  character === undefined || /\s/.test(character);

const isWord = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character);

/** Whether a wrapping block may break between `text[index]` and the character after it. */
function breaksAfter(text: string, index: number): boolean {
  const character = text[index];
  const next = text[index + 1];
  if (character === undefined || next === undefined || !BREAK_AFTER.has(character)) return false;
  if (isSpace(next) || NEVER_BEFORE.has(next)) return false;
  const before = text[index - 1];
  switch (character) {
    // `://`, `/.well-known` and `a/b` are runs of punctuation: the break falls after the run.
    case '/':
    case ':':
      return true;
    // A dot that ends a name or a number, never a leading dot (`.env`) or an ellipsis.
    case '.':
      return !isSpace(before) && !BREAK_AFTER.has(before ?? ' ');
    // A hyphen inside a word, never a flag's dashes or a minus sign.
    case '-':
      return isWord(before) && isWord(next);
    // A quote that closes a word; one that opens a string stays in front of what it holds.
    default:
      return isWord(before) || before === '/' || before === '.';
  }
}

/**
 * Cuts `text` after each place a wrapping block may break. A browser offers no break after a slash
 * or a colon, so a URL longer than the line is cut wherever the line ends (`…/bureau/m` and `cp`).
 * The places are after `/`, `.`, `:`, `-` and a closing `"`; whitespace needs none. The pieces
 * joined are exactly `text`: nothing is added to the text that is shown and copied.
 */
export function breakPoints(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (!breaksAfter(text, index)) continue;
    pieces.push(text.slice(start, index + 1));
    start = index + 1;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/** The class a word takes when it has places to break, so a wrapping block keeps it in one box. */
const wordClass = 'cinder-code-block__word';

/**
 * Cuts `text` into its words and the whitespace between them, each word with the pieces it may break
 * between: a word with one piece has no place to break and is drawn as plain text, and one with
 * more is drawn in a box of its own (`wordClass`). The runs joined are exactly `text`.
 */
export function splitWords(text: string): { text: string; pieces: string[] }[] {
  return text
    .split(/(\s+)/)
    .filter((run) => run !== '')
    .map((run) => ({ text: run, pieces: /^\s/.test(run) ? [run] : breakPoints(run) }));
}

/** Text a block must leave as it is: a flag (one atomic box) and a note (prose, not code). */
const KEEP_WHOLE = `.${flagClass}, small`;

/**
 * Highlighted code is fresh DOM, so each word that has places to break can be put in a box of its
 * own with a break opportunity (`<wbr>`, which adds no character to the copied text) after each
 * piece. A wrapping block uses it so a long URL that fits a row moves to it whole, and one that is
 * wider than a row breaks at a slash or a dot, never inside a word. Flags and notes are left alone.
 */
export const allowBreaksAtPunctuation: Attachment<HTMLElement> = (container) => {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.parentElement?.closest(KEEP_WHOLE) == null) nodes.push(node);
  }
  const boxes: HTMLElement[] = [];
  for (const node of nodes) {
    const runs = splitWords(node.data);
    if (!runs.some((run) => run.pieces.length > 1)) continue;
    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      if (run.pieces.length < 2) {
        fragment.append(run.text);
        continue;
      }
      const box = document.createElement('span');
      box.className = wordClass;
      for (const [index, piece] of run.pieces.entries()) {
        box.append(piece);
        if (index < run.pieces.length - 1) box.append(document.createElement('wbr'));
      }
      boxes.push(box);
      fragment.append(box);
    }
    node.replaceWith(fragment);
  }
  return () => {
    for (const box of boxes) box.replaceWith(box.textContent);
  };
};

/**
 * How far a line is indented, in the two units a stylesheet can measure: spaces, and tabs (a tab is
 * as wide as `--cinder-type-tab-size`). A wrapped line hangs its further rows from this, so they sit
 * under the line's own text and not left of it.
 */
export function leadingIndent(text: string): { spaces: number; tabs: number } {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? '';
  const tabs = indent.split('\t').length - 1;
  return { spaces: indent.length - tabs, tabs };
}

/**
 * An attachment that records the indent of each line of highlighted code, for the hanging indent of
 * a wrapping block (plain code records its own, in the markup).
 */
export const hangWrappedLines: Attachment<HTMLElement> = (container) => {
  const lines = [...container.querySelectorAll<HTMLElement>('pre code > .line, code > .line')];
  for (const line of lines) {
    const { spaces, tabs } = leadingIndent(line.textContent ?? '');
    line.style.setProperty('--_cinder-code-block-indent-spaces', String(spaces));
    line.style.setProperty('--_cinder-code-block-indent-tabs', String(tabs));
  }
  return () => {
    for (const line of lines) {
      line.style.removeProperty('--_cinder-code-block-indent-spaces');
      line.style.removeProperty('--_cinder-code-block-indent-tabs');
    }
  };
};

/** The class a line takes when a note of this tone belongs to it. */
export function lineToneClass(tone: CodeBlockAnnotationTone): string {
  return `cinder-code-block__line--${tone}`;
}

/** The class a note takes for its tone. */
export function annotationToneClass(tone: CodeBlockAnnotationTone): string {
  return `cinder-code-block__annotation--${tone}`;
}

function buildAnnotation(annotation: CodeBlockAnnotation): HTMLElement {
  const tone = annotation.tone ?? 'danger';
  // A `<small>` and not a `<span>`: the stylesheet that keeps Shiki's own span backgrounds and
  // colors off the code (and swaps token colors in dark mode) targets every span in the block.
  const note = document.createElement('small');
  note.className = `cinder-code-block__annotation ${annotationToneClass(tone)}`;
  note.setAttribute('role', 'note');
  const icon = document.createElementNS(svgNamespace, 'svg');
  for (const [name, value] of Object.entries({
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    icon.setAttribute(name, value);
  }
  for (const data of glyphs[tone]) {
    const path = document.createElementNS(svgNamespace, 'path');
    path.setAttribute('d', data);
    icon.append(path);
  }
  note.append(icon, annotation.message);
  return note;
}

/**
 * An attachment that prepares the lines of highlighted code and draws `annotations` under theirs.
 *
 * `onLines` is told whether the highlighter drew line elements at all. A highlighter that does
 * not, such as one that returns a single `<code>` element, cannot be numbered, and the block
 * falls back to its plain rendering, which can.
 */
export function decorateHighlightedLines(
  annotations: readonly CodeBlockAnnotation[] | undefined,
  onLines: (found: boolean) => void,
): Attachment<HTMLElement> {
  return (container) => {
    const lines = [...container.querySelectorAll<HTMLElement>('pre code > .line, code > .line')];
    onLines(lines.length > 0);
    const marked: [HTMLElement, string][] = [];
    const inserted: HTMLElement[] = [];
    for (const line of lines) line.classList.add('cinder-code-block__line');
    for (const annotation of annotations ?? []) {
      const line = lines[Math.trunc(annotation.line) - 1];
      if (!line) continue;
      const toneClass = lineToneClass(annotation.tone ?? 'danger');
      line.classList.add(toneClass);
      marked.push([line, toneClass]);
      // Notes for one line keep the order they were given in.
      let anchor: Element = line;
      while (anchor.nextElementSibling?.classList.contains('cinder-code-block__annotation')) {
        anchor = anchor.nextElementSibling;
      }
      const note = buildAnnotation(annotation);
      anchor.after(note);
      inserted.push(note);
    }
    return () => {
      for (const note of inserted) note.remove();
      for (const [line, toneClass] of marked) line.classList.remove(toneClass);
      for (const line of lines) line.classList.remove('cinder-code-block__line');
    };
  };
}
