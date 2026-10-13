import type { OutputChannel } from '../messages.ts';
import { encodeUtf8 } from '../utf8.ts';

/**
 * One byte sequence a terminal program might write, to be delivered in arbitrary chunks and
 * compared with the contiguous bytes. The corpus is data only: it names no terminal engine, so the
 * protocol suite can prove delivery without one and a renderer suite can later replay the same
 * bytes and compare screen state.
 */
export type CorpusFixture = {
  /** A stable identifier. Later suites report results against these and never rename them. */
  readonly id: string;
  readonly description: string;
  /** The contiguous payload every chunking must reproduce exactly. */
  readonly bytes: Uint8Array;
  /** Chunks the fixture insists on, including zero-length ones, in addition to generated splits. */
  readonly declaredChunks?: readonly Uint8Array[];
  /** The producer reuses and overwrites its buffer as soon as it has handed a chunk over. */
  readonly mutatesProducerBuffer?: boolean;
  readonly channel: OutputChannel;
};

const ESC = '\u001b';

/** Join text and raw byte runs, so a fixture can mix valid text with bytes that are not UTF-8. */
function bytesOf(...parts: readonly (string | readonly number[])[]): Uint8Array {
  const encoded = parts.map((part) => (typeof part === 'string' ? encodeUtf8(part) : part));
  const joined = new Uint8Array(encoded.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of encoded) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

const emptyChunks = [
  new Uint8Array(0),
  encodeUtf8('prompt'),
  new Uint8Array(0),
  new Uint8Array(0),
  encodeUtf8('$ '),
  new Uint8Array(0),
];

/** The fixture identifiers the protocol suite requires, in the order of the matrix. */
export const REQUIRED_CORPUS_FIXTURE_IDS = [
  'utf8-split-alpha',
  'control-split-sgr',
  'csi-osc-terminators',
  'combining-and-zwj',
  'cjk-width',
  'rtl-logical-order',
  'soft-wrap-retention',
  'alternate-screen',
  'cursor-and-attributes',
  'invalid-utf8',
  'query-reply',
  'nul-and-binary-mouse',
  'empty-chunks',
  'producer-mutation',
] as const;

export type CorpusFixtureId = (typeof REQUIRED_CORPUS_FIXTURE_IDS)[number];

/** Every fixture, keyed by identifier and ordered like `REQUIRED_CORPUS_FIXTURE_IDS`. */
export const CORPUS: readonly (CorpusFixture & { readonly id: CorpusFixtureId })[] = [
  {
    id: 'utf8-split-alpha',
    description: 'Two, three and four byte UTF-8 sequences that a chunk boundary can cut in half.',
    bytes: bytesOf('Aα é 日本 \u{1f600} done'),
    channel: 'pty',
  },
  {
    id: 'control-split-sgr',
    description: 'SGR color sequences, including a truecolor one with many parameters.',
    bytes: bytesOf(`${ESC}[31mred${ESC}[0m ${ESC}[38;2;255;100;0morange${ESC}[0m`),
    channel: 'pty',
  },
  {
    id: 'csi-osc-terminators',
    description: 'CSI, and OSC strings ended by BEL and by the two-byte string terminator.',
    bytes: bytesOf(
      `${ESC}[2J${ESC}[H`,
      `${ESC}]0;window title\u0007`,
      `${ESC}]8;;https://example.test/${ESC}\\link${ESC}]8;;${ESC}\\`,
    ),
    channel: 'pty',
  },
  {
    id: 'combining-and-zwj',
    description: 'A combining mark, a zero-width-joiner family and a regional indicator pair.',
    bytes: bytesOf('é \u{1f468}‍\u{1f469}‍\u{1f467} \u{1f1fa}\u{1f1f8}'),
    channel: 'pty',
  },
  {
    id: 'cjk-width',
    description: 'Double-width CJK and Hangul text beside full-width Latin letters.',
    bytes: bytesOf('日本語 ＡＢＣ 한글'),
    channel: 'pty',
  },
  {
    id: 'rtl-logical-order',
    description: 'Right-to-left text kept in logical order beside left-to-right text.',
    bytes: bytesOf('שלום abc مرحبا'),
    channel: 'pty',
  },
  {
    id: 'soft-wrap-retention',
    description: 'A run longer than a typical row, followed by a hard line break.',
    bytes: bytesOf(`${'1234567890'.repeat(12)}\r\n`),
    channel: 'pty',
  },
  {
    id: 'alternate-screen',
    description: 'Enter the alternate screen, draw, and leave it again.',
    bytes: bytesOf(`${ESC}[?1049h${ESC}[2J${ESC}[1;1Hfull screen${ESC}[?1049l`),
    channel: 'pty',
  },
  {
    id: 'cursor-and-attributes',
    description: 'Cursor positioning, save and restore, and bold, underline and reverse video.',
    bytes: bytesOf(`${ESC}[2;3H${ESC}[1;4;7mX${ESC}[0m${ESC}[s${ESC}[1;1H${ESC}[u`),
    channel: 'pty',
  },
  {
    id: 'invalid-utf8',
    description: 'Overlong, surrogate, out-of-range, stray continuation and truncated sequences.',
    bytes: bytesOf(
      'ok ',
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xf8, 0x88, 0x80, 0x80, 0x80],
      [0xff, 0x80, 0xe2, 0x82],
    ),
    channel: 'pty',
  },
  {
    id: 'query-reply',
    description: 'Terminal queries a program writes and expects the terminal to answer.',
    bytes: bytesOf(`${ESC}[6n${ESC}[c${ESC}]10;?\u0007`),
    channel: 'pty',
  },
  {
    id: 'nul-and-binary-mouse',
    description: 'NUL bytes, an SGR mouse report and an X10 mouse report with bytes above 0x7f.',
    bytes: bytesOf([0x00, 0x00], `${ESC}[<0;10;5M`, `${ESC}[M`, [0x20, 0xe0, 0xf0], [0x00]),
    channel: 'pty',
  },
  {
    id: 'empty-chunks',
    description: 'A producer that emits zero-length chunks between real ones.',
    bytes: bytesOf('prompt$ '),
    declaredChunks: emptyChunks,
    channel: 'stdout',
  },
  {
    id: 'producer-mutation',
    description:
      'A producer that scribbles over its buffer as soon as a chunk has been handed over.',
    bytes: bytesOf(`first chunk ${ESC}[1mbold${ESC}[0m last chunk`),
    mutatesProducerBuffer: true,
    channel: 'pty',
  },
];
