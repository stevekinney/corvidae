/**
 * Rewriting the frontmatter of an agent file that Bureau did not author (COR-1524).
 *
 * The keys Bureau knows are its to change; every other key belongs to whatever else reads the
 * file, and a rewrite must not change what that reader sees. Re-emitting the whole frontmatter
 * cannot promise that: a YAML library that reads `created: 2024-01-01` as text writes it back as
 * a date, or the other way round, and it drops comments and layout. So the rewrite is surgical.
 * Each known key's lines are replaced (or removed, or appended), and every other line, comments
 * included, is kept byte for byte.
 *
 * A line edit can be fooled by YAML it does not understand, so the result is read back and must
 * hold exactly the keys and values the caller asked for. When it does not, the whole frontmatter
 * is re-emitted instead, which keeps values and types but drops comments and layout.
 *
 * @module agent-file-frontmatter
 */

import { isDeepStrictEqual } from 'node:util';

import { CORE_SCHEMA, DEFAULT_SCHEMA, dump, load as loadYaml } from 'js-yaml';

type LineEnding = '\n' | '\r\n';

/** One key's place in the frontmatter: the comment lines that lead it, and its own lines. */
interface Block {
  readonly key: string | undefined;
  readonly leading: string[];
  body: string[];
}

// A key whose value starts on the next line ends its own line right after the colon, and `$`
// without the multiline flag matches only the end of the text, so the line break is named.
const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]|\r?\n|$)/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?\r?\n?$/;

/** Emit `mapping` as YAML that keeps a string that looks like a date or a number a string. */
export function emitMapping(mapping: Record<string, unknown>, lineEnding: LineEnding): string {
  const yaml = dump(mapping, { schema: DEFAULT_SCHEMA, lineWidth: -1, noRefs: true });
  return lineEnding === '\n' ? yaml : yaml.replaceAll('\n', lineEnding);
}

function splitBlocks(text: string): Block[] {
  const lines = text.length === 0 ? [] : text.split(/(?<=\n)/);
  const blocks: Block[] = [];
  let pendingLeading: string[] = [];
  let current: Block | undefined;
  for (const line of lines) {
    const match = KEY_LINE.exec(line);
    if (match !== null) {
      current = { key: match[1], leading: pendingLeading, body: [line] };
      pendingLeading = [];
      blocks.push(current);
    } else if (current === undefined || BLANK_OR_COMMENT.test(line)) {
      // Blank and comment lines lead the key that follows them, wherever they sit.
      pendingLeading.push(line);
    } else {
      // Pending lines were comments inside this key's value after all.
      current.body.push(...pendingLeading, line);
      pendingLeading = [];
    }
  }
  if (pendingLeading.length > 0) blocks.push({ key: undefined, leading: pendingLeading, body: [] });
  return blocks;
}

function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const a = Object.keys(left).toSorted();
  const b = Object.keys(right).toSorted();
  return isDeepStrictEqual(a, b) && a.every((key) => isDeepStrictEqual(left[key], right[key]));
}

/**
 * `existing` with the known keys set to `known`, or `undefined` when a line edit cannot be
 * verified. A key in `knownKeys` that `known` lacks is removed.
 */
function rewriteLines(
  existing: { readonly frontmatter: string; readonly raw: Readonly<Record<string, unknown>> },
  known: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
  lineEnding: LineEnding,
): string | undefined {
  const blocks = splitBlocks(existing.frontmatter);
  const handled = new Set<string>();
  for (const block of blocks) {
    if (block.key === undefined || !knownKeys.includes(block.key)) continue;
    handled.add(block.key);
    if (!(block.key in known)) {
      block.body = [];
    } else if (!isDeepStrictEqual(existing.raw[block.key], known[block.key])) {
      block.body = [emitMapping({ [block.key]: known[block.key] }, lineEnding)];
    }
  }
  let text = blocks.map((block) => [...block.leading, ...block.body].join('')).join('');
  const appended = Object.keys(known).filter((key) => !handled.has(key));
  if (appended.length > 0) {
    if (text.length > 0 && !text.endsWith('\n')) text += lineEnding;
    text += appended.map((key) => emitMapping({ [key]: known[key] }, lineEnding)).join('');
  }
  const expected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing.raw)) {
    if (!knownKeys.includes(key)) expected[key] = value;
  }
  Object.assign(expected, known);
  try {
    const reread: unknown = loadYaml(text, { schema: CORE_SCHEMA }) ?? {};
    const mapping = typeof reread === 'object' && reread !== null ? reread : undefined;
    return mapping !== undefined && sameKeys(mapping as Record<string, unknown>, expected)
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

/** The whole frontmatter re-emitted: values and types of the other keys kept, comments and layout not. */
function reemit(
  existing: { readonly frontmatter: string; readonly raw: Readonly<Record<string, unknown>> },
  known: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
  lineEnding: LineEnding,
): string {
  // Read the way a default-schema reader (gray-matter, js-yaml's default) reads it, so a date
  // that was a date is written back as one and a string that was quoted stays quoted.
  let source: Record<string, unknown> = { ...existing.raw };
  try {
    const asDefault: unknown = loadYaml(existing.frontmatter, { schema: DEFAULT_SCHEMA });
    if (typeof asDefault === 'object' && asDefault !== null && !Array.isArray(asDefault)) {
      source = asDefault as Record<string, unknown>;
    }
  } catch {
    // Keep what the core schema read.
  }
  const mapping: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!knownKeys.includes(key)) mapping[key] = value;
    else if (key in known) mapping[key] = known[key];
  }
  for (const [key, value] of Object.entries(known)) {
    if (!(key in mapping)) mapping[key] = value;
  }
  return emitMapping(mapping, lineEnding);
}

/**
 * The frontmatter text for `existing` once its known keys are `known`. Lines Bureau does not own
 * are kept as they are; see the module comment for the fallback.
 */
export function rewriteFrontmatter(
  existing: { readonly frontmatter: string; readonly raw: Readonly<Record<string, unknown>> },
  known: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
  lineEnding: LineEnding,
): string {
  return (
    rewriteLines(existing, known, knownKeys, lineEnding) ??
    reemit(existing, known, knownKeys, lineEnding)
  );
}
