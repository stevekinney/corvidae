/**
 * Publishing and withdrawing an agent file (COR-1526): setting `published` in its frontmatter and
 * nothing else.
 *
 * Only the `published` line changes. Every other key keeps the line it has, whether it holds an
 * empty list, a null, a padded string, or a comment, and so does the body. A file that already
 * has the requested state is not rewritten.
 *
 * @module agent-file-publication
 */

import { isDeepStrictEqual } from 'node:util';

import { parseAgentFile, type ParsedAgentFile } from './agent-file';
import { rewriteFrontmatter } from './agent-file-frontmatter';

const textEncoder = new TextEncoder();

/**
 * The `published` line of a frontmatter when it holds a boolean on that one line, with whatever
 * follows the value (a comment, trailing spaces) kept as it is.
 */
const PUBLISHED_LINE =
  /^(published[ \t]*:[ \t]*)(?:true|false|True|False|TRUE|FALSE)(?=[ \t]*(?:#.*)?\r?$)/m;

/** `file` with only its `published` value changed, in text, or `undefined` when a line edit cannot be verified. */
function replacePublishedLine(file: ParsedAgentFile, published: boolean): string | undefined {
  if (!PUBLISHED_LINE.test(file.frontmatter)) return undefined;
  return file.frontmatter.replace(PUBLISHED_LINE, `$1${published}`);
}

/** Whether `frontmatter` reads back as `file`'s own keys with only `published` set to `published`. */
function onlyPublishedChanged(
  file: ParsedAgentFile,
  frontmatter: string,
  published: boolean,
): boolean {
  const reread = parseAgentFile('x', `---\n${frontmatter}---\n`);
  return reread.ok && isDeepStrictEqual(reread.file.raw, { ...file.raw, published });
}

/**
 * The bytes of `file` with `published` set, or `undefined` when it already has that state (a
 * file with no `published` key is withdrawn).
 */
export function serializePublication(
  file: ParsedAgentFile,
  published: boolean,
): Uint8Array | undefined {
  if (file.definition.published === published) return undefined;
  const edited = replacePublishedLine(file, published);
  const frontmatter =
    edited !== undefined && onlyPublishedChanged(file, edited, published)
      ? edited
      : rewriteFrontmatter(file, { published }, ['published'], file.lineEnding);
  const prefix = file.byteOrderMark ? '﻿' : '';
  const fence = `---${file.lineEnding}`;
  return textEncoder.encode(`${prefix}${fence}${frontmatter}${fence}${file.body}`);
}
