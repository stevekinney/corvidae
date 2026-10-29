/**
 * Every poll and timer in Interborough's source says why it is still there (COR-1725). A view that
 * follows the engine asks again on an event and polls only while its feed is not live; the sites
 * that remain are few and each one is named. This reads every non-test `.ts` and `.svelte` file
 * under `src` and fails when a `refetchInterval` property, a `new PollingSource(`, a `setInterval(`
 * or a `setTimeout(` has no `// poll-reason: <reason>` comment on the line above, or when the
 * reason is not one of the six below, so a new poll cannot arrive unexplained.
 *
 * - `fallback`: polls only while its live source is not `live`.
 * - `static`: reads something that cannot change while the page is open, and polls to recover from
 *   a transient fault.
 * - `time-derived`: reads something that changes with the clock, which no event announces.
 * - `mcp-transport`: the host page of an MCP app, which has no feed to follow.
 * - `clock`: a timer that re-renders from the local clock and issues no request.
 * - `timer`: a debounce, a backoff, a reconnect, or a flush.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOT = join(import.meta.dir, '..');

const POLL_REASONS: ReadonlySet<string> = new Set([
  'fallback',
  'static',
  'time-derived',
  'mcp-transport',
  'clock',
  'timer',
]);

/** A call or property that makes the page ask again, or run, on a timer. */
const POLL_SITE = /\brefetchInterval\b|\bnew PollingSource\(|\bsetInterval\(|\bsetTimeout\(/;

const REASON_COMMENT = /^\s*\/\/ poll-reason: (\S+)\s*$/;

/** A test, a test helper or a test harness: `a.test.ts`, `a.test-support.ts`, `a.test-harness.svelte`. */
const TEST_FILE = /\.test(-[a-z]+)?\.(ts|svelte)$/;

interface PollViolation {
  readonly line: number;
  readonly text: string;
  readonly problem: string;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** The sites in one file's source that have no valid reason on the line above. */
function findUnexplainedPolls(source: string): PollViolation[] {
  const lines = source.split('\n');
  const violations: PollViolation[] = [];
  for (const [index, line] of lines.entries()) {
    if (isCommentLine(line) || !POLL_SITE.test(line.replace(/\s\/\/.*$/, ''))) continue;
    const above = index === 0 ? '' : lines[index - 1]!;
    const reason = REASON_COMMENT.exec(above)?.[1];
    if (reason === undefined) {
      violations.push({
        line: index + 1,
        text: line.trim(),
        problem: 'no `// poll-reason: <reason>` comment on the line above',
      });
    } else if (!POLL_REASONS.has(reason)) {
      violations.push({
        line: index + 1,
        text: line.trim(),
        problem: `"${reason}" is not one of ${[...POLL_REASONS].join(', ')}`,
      });
    }
  }
  return violations;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isSource = entry.name.endsWith('.ts') || entry.name.endsWith('.svelte');
    return isSource && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

describe('the poll-reason guard', () => {
  test('accepts a site whose line above names one of the six reasons', () => {
    for (const reason of POLL_REASONS) {
      expect(
        findUnexplainedPolls(`  // poll-reason: ${reason}\n  refetchInterval: 30_000,`),
      ).toEqual([]);
    }
  });

  test('finds each kind of site that has no reason', () => {
    const sources = [
      'createQuery(() => ({ refetchInterval: 30_000 }));',
      'const source = new PollingSource(read);',
      'const timer = setInterval(tick, 1000);',
      'const timer = setTimeout(flush, 100);',
      'globalThis.setTimeout(flush, 100);',
    ];
    for (const source of sources) {
      expect(findUnexplainedPolls(`const before = 1;\n${source}`)).toHaveLength(1);
    }
  });

  test('finds a reason that is not one of the six, or that sits two lines above', () => {
    expect(findUnexplainedPolls('// poll-reason: because\nsetTimeout(a, 1);')).toHaveLength(1);
    expect(
      findUnexplainedPolls('// poll-reason: timer\nconst a = 1;\nsetTimeout(a, 1);'),
    ).toHaveLength(1);
    expect(findUnexplainedPolls('// poll-reason: timer later\nsetTimeout(a, 1);')).toHaveLength(1);
  });

  test('ignores a comment that only mentions a poll, and a call that is not one', () => {
    expect(
      findUnexplainedPolls(
        [
          '// the refetchInterval is 30s',
          ' * a setTimeout( here is prose',
          'clearTimeout(timer);',
          'clearInterval(timer);',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('every poll and timer in the source names why it is there', () => {
    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) =>
      findUnexplainedPolls(readFileSync(path, 'utf8')).map(
        (violation) =>
          `${relative(SOURCE_ROOT, path)}:${violation.line}: ${violation.problem}: ${violation.text}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  test('reads the source it is meant to guard', () => {
    const files = sourceFiles(SOURCE_ROOT).map((path) => relative(SOURCE_ROOT, path));
    expect(files).toContain('routes/workers/workers-data.ts');
    expect(files).toContain('app/view-frame.svelte');
    expect(files.some((file) => TEST_FILE.test(file))).toBe(false);
  });
});
