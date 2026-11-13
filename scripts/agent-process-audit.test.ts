import { describe, expect, test } from 'bun:test';

import {
  auditProcesses,
  describeFinding,
  parseWorkingDirectories,
  parseWorktreeRoots,
  stopOrphans,
  type AuditInput,
} from './agent-process-audit.ts';
import type { ProcessEntry, ProcessTable } from './bun-test-pool.ts';

const main = '/work/corvidae';
const worktree = '/work/corvidae/.claude/worktrees/one';
const startedAt = 'Thu Nov 12 12:00:00 2026';
const now = Date.parse(startedAt) + 30 * 60_000;

function entry(parent: number, command: string, overrides: Partial<ProcessEntry> = {}) {
  return {
    parent,
    processGroup: parent,
    startedAt,
    command,
    residentBytes: 1024 ** 2,
    ...overrides,
  };
}

function audit(
  table: ProcessTable,
  workingDirectories: Record<number, string>,
  overrides: Partial<AuditInput> = {},
) {
  return auditProcesses({
    table,
    workingDirectories: new Map(
      Object.entries(workingDirectories).map(([pid, directory]) => [Number(pid), directory]),
    ),
    roots: [main, worktree],
    exempt: new Set(),
    now,
    olderThanMilliseconds: 6 * 3_600_000,
    ...overrides,
  });
}

describe('parsing', () => {
  test('reads the worktree roots from the porcelain listing', () => {
    const porcelain = `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD def\ndetached\n`;
    expect(parseWorktreeRoots(porcelain)).toEqual([main, worktree]);
  });

  test('reads each working directory from the lsof listing', () => {
    expect(parseWorkingDirectories(`p10\nfcwd\nn${main}\np11\nfcwd\nn/tmp\n`)).toEqual(
      new Map([
        [10, main],
        [11, '/tmp'],
      ]),
    );
  });
});

describe('auditProcesses', () => {
  test('lists an orphan by its working directory, though its command names no path', () => {
    const table = new Map([[10, entry(1, 'bun scripts/serve.ts --preview')]]);
    const findings = audit(table, { 10: `${worktree}/scripts/browser-fixtures` });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      pid: 10,
      worktree,
      reasons: ['orphaned (parent is pid 1)'],
      ageMilliseconds: 30 * 60_000,
    });
  });

  test('lists an orphan by a path in its command line', () => {
    const table = new Map([
      [10, entry(1, `bun ${main}/applications/interborough/tests/e2e/e2e-server.ts`)],
    ]);
    expect(audit(table, { 10: '/' }).map((finding) => finding.worktree)).toEqual([main]);
  });

  test('leaves a young process with a living parent alone', () => {
    const table = new Map([[10, entry(9, 'bun test')]]);
    expect(audit(table, { 10: main })).toEqual([]);
  });

  test('lists a process older than the threshold even while its parent lives', () => {
    const table = new Map([[10, entry(9, 'bun test')]]);
    const findings = audit(table, { 10: main }, { now: now + 7 * 3_600_000 });
    expect(findings.map((finding) => finding.reasons)).toEqual([['older than 6 h']]);
  });

  test("never lists a session's own old processes: the agent, its shells, its MCP servers", () => {
    const table = new Map([
      [10, entry(9, '/Users/someone/Library/Application Support/Claude/claude --verbose')],
      [11, entry(9, '/bin/zsh -l')],
      [12, entry(9, '/Users/someone/.local/bin/github-mcp-server stdio')],
    ]);
    const directories = { 10: main, 11: main, 12: main };
    expect(audit(table, directories, { now: now + 30 * 3_600_000 })).toEqual([]);
  });

  test('marks only a process whose parent is pid 1 as an orphan, the one kind --kill stops', () => {
    const table = new Map([
      [10, entry(1, 'sh -c bun scripts/build.ts && bun scripts/serve.ts')],
      [11, entry(9, '/opt/homebrew/bin/bun run dev')],
    ]);
    const findings = audit(table, { 10: main, 11: main }, { now: now + 7 * 3_600_000 });
    expect(findings.map((finding) => [finding.pid, finding.orphaned])).toEqual([
      [10, true],
      [11, false],
    ]);
  });

  test('never lists a process outside the worktrees, or one in a sibling directory', () => {
    const table = new Map([
      [10, entry(1, 'bun serve.ts')],
      [11, entry(1, `bun ${main}-mirror/serve.ts`)],
    ]);
    expect(audit(table, { 10: '/elsewhere', 11: `${main}-mirror` })).toEqual([]);
  });

  test('never lists the audit, its ancestors, or the Turborepo daemon', () => {
    const table = new Map([
      [10, entry(1, 'zsh')],
      [11, entry(1, `${main}/node_modules/turbo-darwin-arm64/bin/turbo --skip-infer daemon`)],
    ]);
    expect(audit(table, { 10: main, 11: main }, { exempt: new Set([10]) })).toEqual([]);
  });

  test('counts the footprint over resident memory and sorts the largest first', () => {
    const table = new Map([
      [10, entry(1, 'bun a.ts')],
      [11, entry(1, 'bun b.ts')],
    ]);
    const findings = audit(
      table,
      { 10: main, 11: main },
      { readFootprint: (pid) => (pid === 11 ? 5 * 1024 ** 3 : undefined) },
    );
    expect(findings.map((finding) => finding.pid)).toEqual([11, 10]);
    expect(describeFinding(findings[0]!)).toBe(
      `pid 11, 30 min, 5120 MB, orphaned (parent is pid 1), in ${main}: bun b.ts`,
    );
  });
});

describe('stopOrphans', () => {
  const listed = new Map([
    [10, entry(1, 'bun a.ts')],
    [11, entry(1, 'bun b.ts')],
    [12, entry(9, '/opt/homebrew/bin/bun run dev')],
  ]);
  const findings = audit(listed, { 10: main, 11: main, 12: main }, { now: now + 7 * 3_600_000 });

  /** A host on which a process dies when it is sent a signal in `fatal`. */
  function host(table: Map<number, ProcessEntry>, fatal: readonly NodeJS.Signals[]) {
    const sent: [number, NodeJS.Signals][] = [];
    return {
      sent,
      options: {
        readProcessTable: () => new Map(table),
        signal: (pid: number, name: NodeJS.Signals) => {
          sent.push([pid, name]);
          if (fatal.includes(name)) table.delete(pid);
        },
        sleep: async () => {},
      },
    };
  }

  test('signals the orphans and never a listed process whose parent is alive', async () => {
    const { sent, options } = host(new Map(listed), ['SIGTERM']);
    expect(findings.map((finding) => finding.pid)).toEqual([10, 11, 12]);
    expect(await stopOrphans(findings, options)).toEqual([]);
    expect(sent).toEqual([
      [10, 'SIGTERM'],
      [11, 'SIGTERM'],
    ]);
  });

  test('never signals a pid that has been recycled since the listing', async () => {
    const now = new Map(listed);
    now.set(10, entry(1, 'someone else', { startedAt: 'Thu Nov 12 12:29:00 2026' }));
    const { sent, options } = host(now, ['SIGTERM']);
    await stopOrphans(findings, options);
    expect(sent).toEqual([[11, 'SIGTERM']]);
  });

  test('kills an orphan that ignores SIGTERM and reports one that survives even that', async () => {
    const stubborn = host(new Map(listed), ['SIGKILL']);
    expect(await stopOrphans(findings, stubborn.options)).toEqual([]);
    expect(stubborn.sent.filter(([, name]) => name === 'SIGKILL')).toEqual([
      [10, 'SIGKILL'],
      [11, 'SIGKILL'],
    ]);
    const immortal = host(new Map(listed), []);
    const survivors = await stopOrphans(findings, immortal.options);
    expect(survivors.map((finding) => finding.pid)).toEqual([10, 11]);
  });
});
