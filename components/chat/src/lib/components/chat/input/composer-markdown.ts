/**
 * What the composer's Markdown backdrop styles. The text stays the Markdown
 * that is sent; these segments only decide how each run of it looks.
 */
export type ComposerMarkdownSegmentKind =
  'text' | 'marker' | 'strong' | 'emphasis' | 'code' | 'link' | 'list-marker';

/** One run of composer text and how the backdrop styles it. */
export type ComposerMarkdownSegment = {
  /** How the run is styled. */
  kind: ComposerMarkdownSegmentKind;
  /** The run's exact source text. */
  text: string;
};

/** A formatting command from a shortcut or a toolbar button. */
export type ChatComposerFormat = 'bold' | 'italic' | 'code' | 'link' | 'list';

/** What a custom composer toolbar receives. */
export type ChatComposerToolbarContext = {
  /** Applies a formatting command to the composer's selection, as its shortcut would. */
  format: (format: ChatComposerFormat) => void;
};

/** The edit a formatting command makes: replace one range, then select another. */
export type ComposerFormatEdit = {
  /** Start of the range to replace. */
  start: number;
  /** End of the range to replace. */
  end: number;
  /** Text that replaces the range. */
  text: string;
  /** Selection start after the edit. */
  selectionStart: number;
  /** Selection end after the edit. */
  selectionEnd: number;
};

const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/;

// One alternation, tried left to right: code wins over emphasis inside it, and
// strong (`**`) is tried before emphasis (`*`).
const INLINE =
  /(`)([^`\n]+)(`)|(\*\*|__)(?=\S)([^\n]*?\S)\4|(\*|_)(?=[^\s*_])([^\n]*?[^\s*_])\6|(\[)([^\]\n]+)(\]\([^)\s]+\))/g;

function pushText(segments: ComposerMarkdownSegment[], text: string): void {
  if (text === '') return;
  const last = segments.at(-1);
  if (last?.kind === 'text') last.text += text;
  else segments.push({ kind: 'text', text });
}

function wrapped(
  open: string,
  kind: ComposerMarkdownSegmentKind,
  content: string,
  close: string,
): ComposerMarkdownSegment[] {
  return [
    { kind: 'marker', text: open },
    { kind, text: content },
    { kind: 'marker', text: close },
  ];
}

function inlineSegments(line: string): ComposerMarkdownSegment[] {
  const segments: ComposerMarkdownSegment[] = [];
  let cursor = 0;
  for (const match of line.matchAll(INLINE)) {
    const index = match.index;
    // Underscore emphasis needs word boundaries, so `snake_case_name` stays plain.
    if (match[6] === '_' || match[4] === '__') {
      const before = line[index - 1];
      const after = line[index + match[0].length];
      if ((before && /\w/.test(before)) || (after && /\w/.test(after))) continue;
    }
    pushText(segments, line.slice(cursor, index));
    if (match[1]) segments.push(...wrapped('`', 'code', match[2]!, '`'));
    else if (match[4]) segments.push(...wrapped(match[4], 'strong', match[5]!, match[4]));
    else if (match[6]) segments.push(...wrapped(match[6], 'emphasis', match[7]!, match[6]));
    else segments.push(...wrapped('[', 'link', match[9]!, match[10]!));
    cursor = index + match[0].length;
  }
  pushText(segments, line.slice(cursor));
  return segments;
}

/**
 * Splits composer text into styled runs. Joining every run's `text` gives back
 * the input exactly, so the backdrop lines up with the textarea character for
 * character.
 */
export function highlightComposerMarkdown(source: string): ComposerMarkdownSegment[] {
  const segments: ComposerMarkdownSegment[] = [];
  const lines = source.split('\n');
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) pushText(segments, '\n');
    const listMarker = LIST_MARKER.exec(line);
    let rest = line;
    if (listMarker) {
      pushText(segments, listMarker[1]!);
      segments.push({ kind: 'list-marker', text: `${listMarker[2]}${listMarker[3]}` });
      rest = line.slice(listMarker[0].length);
    }
    for (const segment of inlineSegments(rest)) {
      if (segment.kind === 'text') pushText(segments, segment.text);
      else segments.push(segment);
    }
  });
  return segments;
}

const WRAP_MARKERS = { bold: '**', italic: '*', code: '`' } as const;

function wrapSelection(value: string, start: number, end: number, marker: string) {
  const before = value.slice(start - marker.length, start);
  const after = value.slice(end, end + marker.length);
  // A selection already wrapped in this marker is unwrapped instead.
  if (before === marker && after === marker && start >= marker.length) {
    return {
      start: start - marker.length,
      end: end + marker.length,
      text: value.slice(start, end),
      selectionStart: start - marker.length,
      selectionEnd: end - marker.length,
    };
  }
  return {
    start,
    end,
    text: `${marker}${value.slice(start, end)}${marker}`,
    selectionStart: start + marker.length,
    selectionEnd: end + marker.length,
  };
}

function linkSelection(value: string, start: number, end: number): ComposerFormatEdit {
  const label = value.slice(start, end);
  if (label === '') {
    // No text yet: place the caret between the brackets.
    return { start, end, text: '[](url)', selectionStart: start + 1, selectionEnd: start + 1 };
  }
  const urlStart = start + label.length + 3;
  return {
    start,
    end,
    text: `[${label}](url)`,
    selectionStart: urlStart,
    selectionEnd: urlStart + 3,
  };
}

function listSelection(value: string, start: number, end: number): ComposerFormatEdit {
  // `lastIndexOf` clamps a negative position to 0, so offset 0 must not search.
  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const nextBreak = value.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const allListed = lines.every((line) => line.startsWith('- '));
  const text = lines
    .map((line) => (allListed ? line.slice(2) : line.startsWith('- ') ? line : `- ${line}`))
    .join('\n');
  const firstShift = allListed ? -2 : lines[0]!.startsWith('- ') ? 0 : 2;
  return {
    start: lineStart,
    end: lineEnd,
    text,
    selectionStart: Math.max(lineStart, start + firstShift),
    selectionEnd: end + (text.length - (lineEnd - lineStart)),
  };
}

/** The edit a formatting command makes to the composer text and selection. */
export function applyComposerFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: ChatComposerFormat,
): ComposerFormatEdit {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  if (format === 'link') return linkSelection(value, start, end);
  if (format === 'list') return listSelection(value, start, end);
  return wrapSelection(value, start, end, WRAP_MARKERS[format]);
}

const SHORTCUT_FORMATS: Readonly<Record<string, ChatComposerFormat>> = {
  b: 'bold',
  i: 'italic',
  e: 'code',
  k: 'link',
};

/** The format a keydown asks for: Cmd or Ctrl with B, I, E, or K, and nothing else held. */
export function composerShortcutFormat(event: KeyboardEvent): ChatComposerFormat | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return undefined;
  const key = event.key.toLowerCase();
  return Object.hasOwn(SHORTCUT_FORMATS, key) ? SHORTCUT_FORMATS[key] : undefined;
}
