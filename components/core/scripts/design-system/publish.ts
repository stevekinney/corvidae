/**
 * The publishable parts that are not per component: the brand book, the system index, and the
 * plan for publishing the folder in batches.
 */

import { BUNDLE_NAMESPACE } from './bundle.ts';

/** The libraries the design system loads before `components/bundle.js`: React 18, as it reads. */
export const BUNDLE_LIBRARIES = [
  { name: 'react', version: '18' },
  { name: 'react-dom', version: '18' },
];

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spells a whole number below 100 in words, capitalized to start a sentence. */
export function sentenceNumber(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 99) return String(value);
  const ones = value % 10;
  const tens = Math.floor(value / 10);
  const words =
    value < 20 ? (ONES[value] ?? '') : `${TENS[tens] ?? ''}${ones ? `-${ONES[ones] ?? ''}` : ''}`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Lists names as inline code: "`A`", "`A` and `B`", "`A`, `B` and `C`". */
export function codeList(names: string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1) ?? ''}`;
}

/** The facts the brand book states that the build derives. */
export type BrandBookFacts = {
  /** Components whose card is a static rendition. */
  staticComponents: string[];
  /** How many components have guidelines but no card. */
  componentsWithoutCard: number;
};

/** Fills the brand book's placeholders, failing on one it does not know or leaves behind. */
export function fillBrandBook(template: string, facts: BrandBookFacts): string {
  const values = new Map([
    ['staticComponents', codeList(facts.staticComponents)],
    ['componentsWithoutCard', sentenceNumber(facts.componentsWithoutCard)],
  ]);
  return template.replace(/\{\{(\w+)\}\}/g, (_placeholder, key: string) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`brand book has an unknown placeholder {{${key}}}`);
    return value;
  });
}

/** The inputs to {@link designSystemIndex}. */
export type IndexFacts = {
  sha: string;
  author: string;
  note: string;
  /** An ISO 8601 time in UTC to the second, such as `2026-11-09T20:22:38Z`. */
  at: string;
};

/** The system's index, `design-system.json`, which is published last. */
export function designSystemIndex(facts: IndexFacts): Record<string, unknown> {
  return {
    v: 3,
    layout: 'files',
    createdOnFiles: { v: 1, at: facts.at },
    title: 'Cinder',
    // The namespace is the global `components/bundle.js` assigns. The bundle reads React 18 from
    // the page, so the libraries name it for the page to load; a design canvas supplies its own.
    // Each card still loads its own `preview.js`, which needs neither.
    namespace: BUNDLE_NAMESPACE,
    libraries: BUNDLE_LIBRARIES,
    sections: {},
    groups: [],
    assetGroups: {},
    blobs: {},
    docs: { readme: 'project/README.md', sections: [] },
    editing: 'code',
    lastChange: {
      by: facts.author,
      at: facts.at,
      via: `Claude Code, stevekinney/corvidae@${facts.sha}`,
      note: facts.note,
    },
  };
}

/**
 * Where a published text file holds U+FFFD, the replacement character, which the artifact service
 * refuses: one `line:column` (both from 1) per occurrence. Decoding bytes that are not UTF-8 also
 * yields it, so this catches those too.
 */
export function replacementCharacterPositions(text: string): string[] {
  const positions: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (let column = line.indexOf('\uFFFD'); column !== -1;) {
      positions.push(`${index + 1}:${column + 1}`);
      column = line.indexOf('\uFFFD', column + 1);
    }
  });
  return positions;
}

/** The most files one publish sends. */
export const BATCH_FILE_LIMIT = 240;
/** The most bytes one publish sends, kept under the 64 MB a publish may carry. */
export const BATCH_BYTE_LIMIT = 60 * 1024 * 1024;
/** The index, which a publish sends alone and last so the system never points at missing files. */
export const INDEX_PATH = 'project/design-system.json';

/** A file to publish, by its published path. */
export type PublishFile = { path: string; bytes: number };

/**
 * Splits the folder into publishes of at most {@link BATCH_FILE_LIMIT} files and
 * {@link BATCH_BYTE_LIMIT} bytes, in path order, with the index alone in the last one.
 */
export function planPublishBatches(files: PublishFile[]): string[][] {
  const index = files.find((file) => file.path === INDEX_PATH);
  if (!index) throw new Error(`the folder has no ${INDEX_PATH}`);
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  const ordered = files
    .filter((file) => file.path !== INDEX_PATH)
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const file of ordered) {
    if (
      batch.length > 0 &&
      (batch.length === BATCH_FILE_LIMIT || bytes + file.bytes > BATCH_BYTE_LIMIT)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file.path);
    bytes += file.bytes;
  }
  if (batch.length > 0) batches.push(batch);
  batches.push([INDEX_PATH]);
  return batches;
}
