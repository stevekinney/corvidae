/**
 * Keep every reader of a tool result's payload aware of its `parts` (COR-792).
 *
 * A tool result carries its payload in two fields: `content`, the JSON application value, and,
 * when the tool answered with text and media, `parts`. Code that reads only `content` silently
 * loses the parts, which three review rounds found one reader at a time. So every non-test file
 * that reads a tool result's `content` is listed in `tool-result-payload-reads.json` with how it
 * handles `parts`, and this check, run from the root `lint:root` script, fails when a file starts
 * reading `content` without an entry, or keeps an entry after it stops.
 *
 * A file counts as a reader when it reads `toolResult.content` (or `toolResult?.content`), or
 * reads `result.content` and names one of the tool-result types. The second rule is a heuristic:
 * it also matches a run result's `content` in a file that happens to name a tool-result type, and
 * such a file is listed with that reason.
 */

import { Glob } from 'bun';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const allowlistPath = join(import.meta.dir, 'tool-result-payload-reads.json');

const SOURCE_GLOBS = [
  'packages/*/src/**/*.{ts,svelte}',
  'components/*/src/**/*.{ts,svelte}',
  'applications/*/src/**/*.{ts,svelte}',
];
const TEST_FILE = /\.(test|test-d|test-support)\.ts$|\.svelte\.test\.ts$/;
const TOOL_RESULT_CONTENT = /\btoolResult\??\.content\b/;
const RESULT_CONTENT = /\bresult\??\.content\b/;
const TOOL_RESULT_TYPE =
  /\b(ToolResult|ToolExecutionResult|ToolResultLike|ToolResultInput|ChatToolResult)\b/;

/** Whether a file's source reads a tool result's `content`. */
export function readsToolResultContent(source: string): boolean {
  return (
    TOOL_RESULT_CONTENT.test(source) ||
    (RESULT_CONTENT.test(source) && TOOL_RESULT_TYPE.test(source))
  );
}

/** Every non-test source file under `repositoryRoot` that reads a tool result's `content`. */
export async function findToolResultPayloadReaders(repositoryRoot: string): Promise<string[]> {
  const readers = new Set<string>();
  for (const pattern of SOURCE_GLOBS) {
    for await (const file of new Glob(pattern).scan({ cwd: repositoryRoot })) {
      if (file.includes('/node_modules/') || TEST_FILE.test(file)) continue;
      if (readsToolResultContent(await Bun.file(join(repositoryRoot, file)).text())) {
        readers.add(file);
      }
    }
  }
  return [...readers].toSorted();
}

/** Readers with no allowlist entry, and entries for files that no longer read `content`. */
export function compareWithAllowlist(
  readers: readonly string[],
  allowlist: Readonly<Record<string, string>>,
): { unlisted: string[]; stale: string[] } {
  const found = new Set(readers);
  return {
    unlisted: readers.filter((file) => !Object.hasOwn(allowlist, file)),
    stale: Object.keys(allowlist).filter((file) => !found.has(file)),
  };
}

async function main(): Promise<void> {
  const allowlist = (await Bun.file(allowlistPath).json()) as Record<string, string>;
  const { unlisted, stale } = compareWithAllowlist(
    await findToolResultPayloadReaders(root),
    allowlist,
  );
  if (unlisted.length === 0 && stale.length === 0) {
    process.stdout.write(
      `check-tool-result-payload-reads — OK (${Object.keys(allowlist).length} readers, each handling parts).\n`,
    );
    return;
  }
  for (const file of unlisted) {
    process.stderr.write(
      `check-tool-result-payload-reads — ${file} reads a tool result's content: handle its parts too, then list it in scripts/tool-result-payload-reads.json with how.\n`,
    );
  }
  for (const file of stale) {
    process.stderr.write(
      `check-tool-result-payload-reads — ${file} no longer reads a tool result's content: remove its entry from scripts/tool-result-payload-reads.json.\n`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-tool-result-payload-reads failed:', error);
    process.exitCode = 1;
  });
}
