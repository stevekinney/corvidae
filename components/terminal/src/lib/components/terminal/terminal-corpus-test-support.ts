import {
  CORPUS,
  REQUIRED_CORPUS_FIXTURE_IDS,
  type CorpusFixtureId,
} from '@lostgradient/ventriloquist';
import { FitAddon } from '@xterm/addon-fit';
import type { ILinkProvider, Terminal as XtermTerminal } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';

import {
  createRendererEngine,
  type EngineCreateOptions,
  type RendererEngine,
} from './terminal-engine-adapter.ts';

const ESC = '\u001b';
const encoder = new TextEncoder();

/**
 * One cell's expected content and attributes. Only attributes that are set are listed, so an
 * unlisted attribute is expected to be clear.
 */
export type CellOracle = {
  x: number;
  y: number;
  chars: string;
  width: number;
  bold?: true;
  dim?: true;
  inverse?: true;
  underline?: true;
  foreground?: ColorOracle;
  background?: ColorOracle;
};

export type ColorOracle = { mode: 'palette'; index: number } | { mode: 'rgb'; value: number };

/**
 * The state a declared oracle pins for a screen: which buffer is active, where the cursor is, every
 * non-blank viewport row, which rows continue the previous one, chosen cells with their
 * attributes, the replies the engine wrote back, and the titles the program set.
 *
 * Each oracle below is authored by hand from the byte sequence and the terminal semantics it
 * exercises. It is not the engine's output captured and pasted back: a row, cursor position, or
 * attribute that disagreed with the sequence's meaning would fail here.
 */
export type ScreenOracle = {
  bufferType: 'normal' | 'alternate';
  cursor: { x: number; y: number };
  lines: readonly string[];
  wrappedRows?: readonly number[];
  cells?: readonly CellOracle[];
  replies?: readonly string[];
  titles?: readonly string[];
};

export const ORACLE_GEOMETRY = { columns: 40, rows: 8 } as const;

function bytesOf(...parts: readonly (string | readonly number[])[]): Uint8Array {
  const encoded = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
  return Uint8Array.from(encoded.flatMap((part) => [...part]));
}

/**
 * The oracles for the shared byte corpus, at {@link ORACLE_GEOMETRY} and the engine's Unicode 6
 * width tables (the policy `documentation/terminal/contract.md` selects). Under those tables an
 * emoji and each member of a zero-width-joiner sequence take one cell, a regional indicator takes
 * one cell, East Asian wide and full-width characters take two, and a combining mark or joiner
 * takes none and joins the cell before it.
 */
export const CORPUS_ORACLES: Readonly<Record<CorpusFixtureId, ScreenOracle>> = {
  'utf8-split-alpha': {
    bufferType: 'normal',
    // 5 cells for "Aα é", then two wide characters (4), a space, the emoji (1), a space, "done".
    cursor: { x: 16, y: 0 },
    lines: ['Aα é 日本 \u{1f600} done'],
    cells: [
      { x: 1, y: 0, chars: 'α', width: 1 },
      { x: 5, y: 0, chars: '日', width: 2 },
      { x: 7, y: 0, chars: '本', width: 2 },
      { x: 10, y: 0, chars: '\u{1f600}', width: 1 },
    ],
  },
  'control-split-sgr': {
    bufferType: 'normal',
    cursor: { x: 10, y: 0 },
    lines: ['red orange'],
    cells: [
      { x: 0, y: 0, chars: 'r', width: 1, foreground: { mode: 'palette', index: 1 } },
      { x: 2, y: 0, chars: 'd', width: 1, foreground: { mode: 'palette', index: 1 } },
      { x: 3, y: 0, chars: ' ', width: 1 },
      // 38;2;255;100;0 is 0xff6400.
      { x: 4, y: 0, chars: 'o', width: 1, foreground: { mode: 'rgb', value: 0xff_64_00 } },
      { x: 9, y: 0, chars: 'e', width: 1, foreground: { mode: 'rgb', value: 0xff_64_00 } },
    ],
  },
  'csi-osc-terminators': {
    bufferType: 'normal',
    // Clear and home, a title ended by BEL, then OSC 8 text whose destination is never shown.
    cursor: { x: 4, y: 0 },
    lines: ['link'],
    titles: ['window title'],
  },
  'combining-and-zwj': {
    bufferType: 'normal',
    // "e" with a combining acute accent (1), space (1), three emoji joined by zero-width joiners
    // (1 each), space, two flags (1 each).
    cursor: { x: 8, y: 0 },
    lines: ['e\u0301 \u{1f468}\u200d\u{1f469}\u200d\u{1f467} \u{1f1fa}\u{1f1f8}'],
    cells: [
      { x: 0, y: 0, chars: 'e\u0301', width: 1 },
      // The joiner belongs to the cell before it and adds no cell of its own.
      { x: 2, y: 0, chars: '\u{1f468}\u200d', width: 1 },
      { x: 3, y: 0, chars: '\u{1f469}\u200d', width: 1 },
      { x: 4, y: 0, chars: '\u{1f467}', width: 1 },
      { x: 6, y: 0, chars: '\u{1f1fa}', width: 1 },
      { x: 7, y: 0, chars: '\u{1f1f8}', width: 1 },
    ],
  },
  'cjk-width': {
    bufferType: 'normal',
    // 日本語 (6) space (1) ＡＢＣ (6) space (1) 한글 (4).
    cursor: { x: 18, y: 0 },
    lines: ['日本語 ＡＢＣ 한글'],
    cells: [
      { x: 0, y: 0, chars: '日', width: 2 },
      { x: 1, y: 0, chars: '', width: 0 },
      { x: 7, y: 0, chars: 'Ａ', width: 2 },
      { x: 14, y: 0, chars: '한', width: 2 },
    ],
  },
  'rtl-logical-order': {
    bufferType: 'normal',
    // Four Hebrew letters, a space, "abc", a space, five Arabic letters: 14 cells in logical order.
    cursor: { x: 14, y: 0 },
    lines: ['שלום abc مرحبا'],
  },
  'soft-wrap-retention': {
    bufferType: 'normal',
    // 120 digits fill three 40-column rows; the CRLF then starts a fourth.
    cursor: { x: 0, y: 3 },
    lines: ['1234567890'.repeat(4), '1234567890'.repeat(4), '1234567890'.repeat(4)],
    wrappedRows: [1, 2],
  },
  'alternate-screen': {
    // Entering the alternate screen, drawing, and leaving it restores an untouched normal screen.
    bufferType: 'normal',
    cursor: { x: 0, y: 0 },
    lines: [],
  },
  'cursor-and-attributes': {
    bufferType: 'normal',
    // CUP 2;3 is column 2, row 1 (zero-based). "X" is bold, underlined, and inverse. Save, home,
    // and restore return the cursor to just after the X.
    cursor: { x: 3, y: 1 },
    lines: ['', '  X'],
    cells: [
      { x: 2, y: 1, chars: 'X', width: 1, bold: true, underline: true, inverse: true },
      { x: 0, y: 0, chars: '', width: 1 },
    ],
  },
  'invalid-utf8': {
    bufferType: 'normal',
    // The engine decodes UTF-8 itself and drops bytes that do not form a character, neither
    // printing a replacement nor corrupting the text around them: only "ok " is visible.
    cursor: { x: 3, y: 0 },
    lines: ['ok '],
  },
  'query-reply': {
    bufferType: 'normal',
    // Nothing is printed. The cursor-position query at (0,0) is answered "1;1R", the primary
    // device-attributes query is answered as a VT100 with advanced video, and the foreground
    // color query is answered with the engine's default foreground, white.
    cursor: { x: 0, y: 0 },
    lines: [],
    replies: [`${ESC}[1;1R`, `${ESC}[?1;2c`, `${ESC}]10;rgb:ffff/ffff/ffff${ESC}\\`],
  },
  'nul-and-binary-mouse': {
    bufferType: 'normal',
    // NULs print nothing and an SGR mouse report is an unhandled private CSI. A bare CSI M deletes
    // a line. The X10 report's 0x20 prints one space; its bytes above 0x7f are not valid UTF-8.
    cursor: { x: 1, y: 0 },
    lines: [' '],
  },
  'empty-chunks': {
    bufferType: 'normal',
    cursor: { x: 8, y: 0 },
    lines: ['prompt$ '],
  },
  'producer-mutation': {
    bufferType: 'normal',
    cursor: { x: 27, y: 0 },
    lines: ['first chunk bold last chunk'],
    cells: [
      { x: 12, y: 0, chars: 'b', width: 1, bold: true },
      { x: 15, y: 0, chars: 'd', width: 1, bold: true },
      { x: 16, y: 0, chars: ' ', width: 1 },
    ],
  },
};

/** A renderer case beyond the shared corpus: bytes and the oracle they must produce. */
export type RendererCase = {
  id: string;
  description: string;
  bytes: Uint8Array;
  oracle: ScreenOracle;
};

export const RENDERER_CASES: readonly RendererCase[] = [
  {
    id: 'ansi-colors',
    description: 'Normal and bright foregrounds, a 256-color foreground and background.',
    bytes: bytesOf(
      `${ESC}[31;42mA${ESC}[0m${ESC}[91mB${ESC}[0m${ESC}[38;5;208mC${ESC}[48;5;17mD${ESC}[0m`,
    ),
    oracle: {
      bufferType: 'normal',
      cursor: { x: 4, y: 0 },
      lines: ['ABCD'],
      cells: [
        // 31 is palette red (1) on 42 palette green (2); 91 is bright red (9).
        {
          x: 0,
          y: 0,
          chars: 'A',
          width: 1,
          foreground: { mode: 'palette', index: 1 },
          background: { mode: 'palette', index: 2 },
        },
        { x: 1, y: 0, chars: 'B', width: 1, foreground: { mode: 'palette', index: 9 } },
        { x: 2, y: 0, chars: 'C', width: 1, foreground: { mode: 'palette', index: 208 } },
        {
          x: 3,
          y: 0,
          chars: 'D',
          width: 1,
          foreground: { mode: 'palette', index: 208 },
          background: { mode: 'palette', index: 17 },
        },
      ],
    },
  },
  {
    id: 'dim-bold-inverse',
    description: 'SGR 2 (dim), 1 (bold), and 7 (inverse), each reset by SGR 0.',
    bytes: bytesOf(`${ESC}[2mE${ESC}[0m${ESC}[1mF${ESC}[0m${ESC}[7mG${ESC}[0mH`),
    oracle: {
      bufferType: 'normal',
      cursor: { x: 4, y: 0 },
      lines: ['EFGH'],
      cells: [
        { x: 0, y: 0, chars: 'E', width: 1, dim: true },
        { x: 1, y: 0, chars: 'F', width: 1, bold: true },
        { x: 2, y: 0, chars: 'G', width: 1, inverse: true },
        { x: 3, y: 0, chars: 'H', width: 1 },
      ],
    },
  },
  {
    id: 'cursor-motion',
    description: 'Forward, down, up, back, home, and absolute positioning, overwriting a cell.',
    bytes: bytesOf(`a${ESC}[3C${ESC}[2Bb${ESC}[1A${ESC}[2Dc${ESC}[H${ESC}[3;5Hz`),
    oracle: {
      bufferType: 'normal',
      // a(0,0); CUF 3 to x=4; CUD 2 to y=2; b(4,2); CUU 1 to y=1; CUB 2 to x=3; c(3,1); home;
      // CUP 3;5 is (4,2), where z overwrites b.
      cursor: { x: 5, y: 2 },
      lines: ['a', '   c', '    z'],
    },
  },
  {
    id: 'erase',
    description: 'Erase to end of line, and erase from start of line to the cursor.',
    bytes: bytesOf(`abcdef\r\nsecond${ESC}[1;3H${ESC}[K${ESC}[2;2H${ESC}[1K`),
    oracle: {
      bufferType: 'normal',
      // EL 0 at (2,0) leaves "ab"; EL 1 at (1,1) blanks columns 0 and 1 of "second".
      cursor: { x: 1, y: 1 },
      lines: ['ab', '  cond'],
    },
  },
  {
    id: 'erase-display',
    description: 'Erase the whole display without moving the cursor.',
    bytes: bytesOf(`abc\r\ndef${ESC}[2J`),
    oracle: { bufferType: 'normal', cursor: { x: 3, y: 1 }, lines: [] },
  },
  {
    id: 'progress-rewrite',
    description: 'A progress line rewritten in place by carriage returns.',
    bytes: bytesOf('10%\r50%\r100%\r\n'),
    oracle: { bufferType: 'normal', cursor: { x: 0, y: 1 }, lines: ['100%'] },
  },
  {
    id: 'wrap-at-last-column',
    description: 'A character written after the last column wraps to the next row.',
    bytes: bytesOf(`${'x'.repeat(40)}y`),
    oracle: {
      bufferType: 'normal',
      cursor: { x: 1, y: 1 },
      lines: ['x'.repeat(40), 'y'],
      wrappedRows: [1],
    },
  },
  {
    id: 'alternate-screen-open',
    description: 'Draw on the alternate screen and stay there.',
    bytes: bytesOf(`main${ESC}[?1049h${ESC}[2J${ESC}[1;1Hfull screen`),
    oracle: { bufferType: 'alternate', cursor: { x: 11, y: 0 }, lines: ['full screen'] },
  },
];

function colorOf(
  mode: number,
  isPalette: boolean,
  isRgb: boolean,
  value: number,
): ColorOracle | undefined {
  if (isPalette) return { mode: 'palette', index: value };
  return isRgb && mode !== 0 ? { mode: 'rgb', value } : undefined;
}

/** What the engine's buffer holds, in the same shape as a {@link ScreenOracle}. */
export function captureScreen(
  terminal: XtermTerminal,
  oracle: ScreenOracle,
  observed: { replies: readonly string[]; titles: readonly string[] },
): ScreenOracle {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  const wrappedRows: number[] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    lines.push(line?.translateToString(true) ?? '');
    if (line?.isWrapped) wrappedRows.push(row);
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const cells = (oracle.cells ?? []).map(({ x, y }): CellOracle => {
    const cell = buffer.getLine(buffer.baseY + y)?.getCell(x);
    if (cell === undefined) return { x, y, chars: '<missing>', width: -1 };
    const captured: CellOracle = { x, y, chars: cell.getChars(), width: cell.getWidth() };
    if (cell.isBold() !== 0) captured.bold = true;
    if (cell.isDim() !== 0) captured.dim = true;
    if (cell.isInverse() !== 0) captured.inverse = true;
    if (cell.isUnderline() !== 0) captured.underline = true;
    const foreground = colorOf(
      cell.getFgColorMode(),
      cell.isFgPalette(),
      cell.isFgRGB(),
      cell.getFgColor(),
    );
    if (foreground !== undefined) captured.foreground = foreground;
    const background = colorOf(
      cell.getBgColorMode(),
      cell.isBgPalette(),
      cell.isBgRGB(),
      cell.getBgColor(),
    );
    if (background !== undefined) captured.background = background;
    return captured;
  });
  return {
    bufferType: buffer.type,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    lines,
    ...(oracle.wrappedRows === undefined ? {} : { wrappedRows }),
    ...(oracle.cells === undefined ? {} : { cells }),
    ...(oracle.replies === undefined ? {} : { replies: [...observed.replies] }),
    ...(oracle.titles === undefined ? {} : { titles: [...observed.titles] }),
  };
}

export type CapturedEngine = {
  engine: RendererEngine;
  terminal: XtermTerminal;
  replies: string[];
  titles: string[];
  /** The link providers the engine registered, in order. */
  linkProviders: ILinkProvider[];
  /** Write `chunks` in order, end the output, and resolve once the last one has been parsed. */
  deliver(chunks: readonly Uint8Array[]): Promise<void>;
  /** Forget everything delivered, as a fresh engine would have. */
  reset(): void;
  capture(oracle: ScreenOracle): ScreenOracle;
};

/**
 * An engine built by the production factory whose underlying terminal is also handed to the test,
 * so the test can read the screen the renderer produced. Only the test sees the terminal.
 */
export function createCapturedEngine(options: Partial<EngineCreateOptions> = {}): CapturedEngine {
  const captured: { terminal?: XtermTerminal } = {};
  const linkProviders: ILinkProvider[] = [];
  class CapturingTerminal extends Terminal {
    constructor(...parameters: ConstructorParameters<typeof Terminal>) {
      super(...parameters);
      captured.terminal = this;
    }

    override registerLinkProvider(provider: ILinkProvider) {
      linkProviders.push(provider);
      return super.registerLinkProvider(provider);
    }
  }
  const titles: string[] = [];
  const engine = createRendererEngine(
    { Terminal: CapturingTerminal, FitAddon },
    {
      readOnly: false,
      announceOutput: false,
      reducedMotion: false,
      ariaLabel: 'Terminal',
      theme: {},
      geometry: { ...ORACLE_GEOMETRY },
      onTitle: (title) => titles.push(title),
      ...options,
    },
  );
  const terminal = captured.terminal!;
  const replies: string[] = [];
  terminal.onData((data) => replies.push(data));
  return {
    engine,
    terminal,
    replies,
    titles,
    linkProviders,
    deliver(chunks) {
      return new Promise<void>((resolve) => {
        const last = chunks.length - 1;
        if (last < 0) {
          resolve();
          return;
        }
        chunks.forEach((chunk, index) => {
          engine.write(chunk, () => {
            if (index === last) resolve();
          });
        });
        // The delivery is the whole of the output, so a unicode prefix the last chunk left
        // unfinished is parsed now and the chunk that carried it is acknowledged.
        engine.finishOutput();
      });
    },
    reset() {
      terminal.reset();
      replies.length = 0;
      titles.length = 0;
    },
    capture: (oracle) => captureScreen(terminal, oracle, { replies, titles }),
  };
}

export const CORPUS_CASES = CORPUS.map((fixture) => ({
  id: fixture.id as string,
  bytes: fixture.bytes,
  declaredChunks: fixture.declaredChunks,
  oracle: CORPUS_ORACLES[fixture.id],
}));

export const ALL_CASES = [
  ...CORPUS_CASES,
  ...RENDERER_CASES.map((rendererCase) => ({
    id: rendererCase.id,
    bytes: rendererCase.bytes,
    declaredChunks: undefined,
    oracle: rendererCase.oracle,
  })),
];

export { REQUIRED_CORPUS_FIXTURE_IDS };
