import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  findPredicate,
  PREDICATES,
  readLog,
  recordOutcome,
  report,
  run,
  shadow,
  shadowId,
  STATE_LIMIT,
  truncateState,
  type ShadowDependencies,
} from './jev-predicates.ts';
import type { FetchLike } from './jev.ts';
import { UsageError } from './process-runner.ts';

let sandbox: string;
let logPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'jev-predicates-'));
  logPath = join(sandbox, 'tmp', 'chef', 'jev-shadow.jsonl');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function wire(answer: unknown): Response {
  return Response.json({ model: 'jev-test', answers: { decision: answer } });
}

/** Dependencies with a stubbed fetch and a clock that advances 40 ms per reading. */
function dependencies(
  response: Response | Error,
  key: string | undefined = 'key',
): ShadowDependencies {
  let reading = 0;
  const fetchLike: FetchLike = async () => {
    if (response instanceof Error) throw response;
    return response.clone();
  };
  return {
    fetch: fetchLike,
    sleep: async () => {},
    now: () => new Date('2026-11-09T12:00:00Z'),
    resolveKey: () => key,
    mainCheckout: () => sandbox,
    clock: () => (reading += 40),
    logPath,
  };
}

const SAMPLES: Record<string, Record<string, unknown>> = {
  'thread-triage': {
    path: 'scripts/a.ts',
    line: 12,
    body: 'This   can race.',
    author: 'codex',
    inDiff: true,
    corIds: ['COR-1'],
  },
  'review-tier': { files: 3, additions: 40, deletions: 2, oneWayDoor: false, paths: ['a.ts'] },
  'dispatch-plan': { criteria: 4, files: ['a.ts'], estimatedLines: 120, oneWayDoor: false },
  'split-before-dispatch': { criteria: 14, files: ['a.ts', 'b.ts'], estimatedLines: 900 },
  'flake-verdict': { test: 'x > y', basePassed: false, rerunPassed: true, error: 'timeout' },
  'drift-action': { identifier: 'COR-9', kind: 'merged-open', state: 'In Review', pullRequest: 5 },
  escalate: { corrections: 2, lastFailure: 'same type error' },
  'criteria-binary': { identifier: 'COR-9', criteria: 'AC1. `bun test x` passes.' },
  'verification-exact': { identifier: 'COR-9', verification: '`bun test x`', files: ['x.ts'] },
  'unanswered-question': {
    identifier: 'COR-9',
    brief: 'b',
    decisions: 'TBD',
    openQuestions: 'none',
  },
  'premise-stale': { identifier: 'COR-9', title: 't', findings: ['missing file x.ts'] },
  'already-done': { identifier: 'COR-9', title: 't', mergedPullRequests: [12], findings: [] },
};

describe('registry', () => {
  test('matches the predicate table in references/decisions.md, kind for kind', () => {
    const decisions = readFileSync(
      join(import.meta.dir, '../../.agents/skills/chef/references/decisions.md'),
      'utf8',
    );
    const rows = new Map<string, string>();
    for (const match of decisions.matchAll(/^\| `([\w-]+)` \|.*\| (\w+) \(\d\.\d+\) \|$/gm))
      rows.set(match[1] as string, match[2] as string);
    expect([...rows.entries()].toSorted(([a], [b]) => a.localeCompare(b))).toEqual(
      PREDICATES.map((predicate): [string, string] => [predicate.id, predicate.kind]).toSorted(
        ([a], [b]) => a.localeCompare(b),
      ),
    );
  });

  test('holds the twelve predicates with unique ids', () => {
    expect(PREDICATES.map((predicate) => predicate.id).toSorted()).toEqual(
      Object.keys(SAMPLES).toSorted(),
    );
    expect(new Set(PREDICATES.map((predicate) => predicate.id)).size).toBe(12);
  });

  test.each(Object.entries(SAMPLES))('%s describes a sample', (id, evidence) => {
    const predicate = findPredicate(id);
    expect(predicate).toBeDefined();
    const description = predicate?.describe(evidence);
    expect(description?.question.length).toBeGreaterThan(20);
    expect(description?.state.length).toBeGreaterThan(0);
    expect(description?.state.length).toBeLessThanOrEqual(STATE_LIMIT);
    expect(['yes-no', 'choice', 'scale']).toContain(description?.mode.type ?? '');
  });

  test('uses the answer specs the task names', () => {
    const modeOf = (id: string) => findPredicate(id)?.describe({}).mode;
    expect(modeOf('thread-triage')).toMatchObject({
      type: 'choice',
      options: {
        fix: expect.any(String),
        decline: expect.any(String),
        tracked: expect.any(String),
      },
    });
    expect(modeOf('review-tier')).toEqual({ type: 'scale', levels: ['none', 'light', 'full'] });
    expect(modeOf('split-before-dispatch')).toEqual({ type: 'yes-no' });
    expect(modeOf('escalate')).toEqual({ type: 'yes-no' });
    expect(Object.keys((modeOf('dispatch-plan') as { options: object }).options)).toEqual([
      'sonnet',
      'sonnet-high',
      'opus',
    ]);
    expect(Object.keys((modeOf('drift-action') as { options: object }).options)).toEqual([
      'close-issue',
      'reopen-issue',
      'link-pr',
      'ignore',
    ]);
  });

  test('summarizes evidence compactly and tolerates missing fields', () => {
    const state = findPredicate('thread-triage')?.describe(SAMPLES['thread-triage'] ?? {}).state;
    expect(state).toContain('body: This can race.');
    expect(state).toContain('linked COR ids: COR-1');
    expect(findPredicate('escalate')?.describe({}).state).toContain('corrections so far: unknown');
  });

  test('truncates deterministically at the limit', () => {
    const long = 'x'.repeat(STATE_LIMIT * 2);
    const first = truncateState(long);
    expect(first.length).toBe(STATE_LIMIT);
    expect(first.endsWith('…[truncated]')).toBe(true);
    expect(truncateState(long)).toBe(first);
    expect(truncateState('short')).toBe('short');
    const described = findPredicate('thread-triage')?.describe({ body: long }).state ?? '';
    expect(described.length).toBe(STATE_LIMIT);
  });
});

describe('shadow', () => {
  test('records a decided answer with latency and a stable id', async () => {
    const evidence = SAMPLES['escalate'] ?? {};
    const entry = await shadow(
      'escalate',
      evidence,
      dependencies(wire({ type: 'noul', noul: 0.97 })),
    );
    expect(entry).toMatchObject({
      predicate: 'escalate',
      decision: 'yes',
      outcome: 'decided',
      latencyMs: 40,
      at: '2026-11-09T12:00:00.000Z',
    });
    expect(entry.confidence).toBeCloseTo(0.97);
    const [line] = readLog(logPath);
    expect(line).toMatchObject({ kind: 'shadow', id: entry.id, predicate: 'escalate' });
    expect(entry.id).toBe(shadowId('escalate', entry.state));
    expect(entry.id).toBe(shadowId('escalate', entry.state));
    expect(shadowId('review-tier', entry.state)).not.toBe(entry.id);
    expect(JSON.parse(readFileSync(logPath, 'utf8').trim())).toHaveProperty('state', entry.state);
  });

  test('records a choice and a scale answer', async () => {
    const choice = await shadow(
      'flake-verdict',
      SAMPLES['flake-verdict'] ?? {},
      dependencies(
        wire({
          type: 'choice',
          choice: 'flake',
          probabilities: { flake: 0.9, regression: 0.05, unknown: 0.05 },
        }),
      ),
    );
    expect(choice).toMatchObject({ decision: 'flake', outcome: 'decided' });
    const scale = await shadow(
      'review-tier',
      SAMPLES['review-tier'] ?? {},
      dependencies(
        wire({ type: 'score', score: 2, probabilities: { '0': 0.02, '1': 0.03, '2': 0.95 } }),
      ),
    );
    expect(scale).toMatchObject({ decision: 'full', outcome: 'decided' });
  });

  test('records below-threshold without throwing', async () => {
    const entry = await shadow('escalate', {}, dependencies(wire({ type: 'noul', noul: 0.6 })));
    expect(entry.outcome).toBe('below-threshold');
    expect(entry.decision).toBe('yes');
    expect(readLog(logPath)).toHaveLength(1);
  });

  test('records unavailable for no key, a network error and a 500', async () => {
    const none = await shadow('escalate', {}, dependencies(wire({}), undefined));
    expect(none).toMatchObject({ outcome: 'unavailable', decision: null, confidence: null });
    const network = await shadow('escalate', {}, dependencies(new Error('down')));
    expect(network.outcome).toBe('unavailable');
    const server = await shadow('escalate', {}, dependencies(new Response('', { status: 500 })));
    expect(server.outcome).toBe('unavailable');
    expect(readLog(logPath)).toHaveLength(3);
  });

  test('does not throw when the log cannot be written', async () => {
    writeFileSync(join(sandbox, 'blocker'), '');
    const entry = await shadow(
      'escalate',
      {},
      {
        ...dependencies(wire({ type: 'noul', noul: 0.97 })),
        logPath: join(sandbox, 'blocker', 'log.jsonl'),
      },
    );
    expect(entry.logged).toBe(false);
    expect(entry.outcome).toBe('decided');
  });

  test('rejects an unknown predicate as a usage error', async () => {
    expect(await rejectionOf(shadow('nope', {}, dependencies(wire({}))))).toBeInstanceOf(
      UsageError,
    );
  });

  test('defaults the log to the main checkout', async () => {
    const { logPath: _omitted, ...rest } = dependencies(wire({ type: 'noul', noul: 0.97 }));
    await shadow('escalate', {}, rest);
    expect(readLog(join(sandbox, 'tmp', 'chef', 'jev-shadow.jsonl'))).toHaveLength(1);
  });
});

describe('outcomes and report', () => {
  test('joins actuals to shadows and computes agreement and latency', async () => {
    const yes = dependencies(wire({ type: 'noul', noul: 0.97 }));
    const first = await shadow('escalate', { corrections: 1 }, yes);
    const second = await shadow('escalate', { corrections: 2 }, yes);
    const third = await shadow('escalate', { corrections: 3 }, yes);
    await shadow('escalate', { corrections: 4 }, yes);
    await shadow('review-tier', {}, dependencies(new Error('down')));
    expect(recordOutcome(first.id, 'yes', yes)).toBe(true);
    expect(recordOutcome(second.id, 'no', yes)).toBe(true);
    expect(recordOutcome(third.id, 'yes', yes)).toBe(true);
    expect(recordOutcome('missing', 'yes', yes)).toBe(false);

    const rows = report(logPath);
    expect(rows.map((row) => row.predicate)).toEqual(['escalate', 'review-tier']);
    expect(rows[0]).toMatchObject({
      count: 4,
      decided: 4,
      compared: 3,
      meanLatencyMs: 40,
    });
    expect(rows[0]?.agreement).toBeCloseTo(2 / 3);
    expect(rows[1]).toMatchObject({ count: 1, decided: 0, compared: 0, agreement: null });
  });

  test('ignores unavailable calls and malformed lines, and a later actual wins', async () => {
    const yes = dependencies(wire({ type: 'noul', noul: 0.97 }));
    const decided = await shadow('escalate', {}, yes);
    const unavailable = await shadow('escalate', { corrections: 9 }, dependencies(new Error('x')));
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}not json\n[]\n`);
    recordOutcome(decided.id, 'no', yes);
    recordOutcome(decided.id, 'yes', yes);
    recordOutcome(unavailable.id, 'yes', yes);
    const [row] = report(logPath);
    expect(row).toMatchObject({ count: 2, compared: 1, agreement: 1 });
  });

  test('reports nothing for a missing log', () => {
    expect(report(join(sandbox, 'absent.jsonl'))).toEqual([]);
  });
});

describe('command line', () => {
  test('list names every predicate', async () => {
    const result = await run(['list', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toHaveLength(12);
    const text = await run(['list']);
    expect(text.output).toContain('thread-triage (routine)');
  });

  test('shadow exits 0 even when Jev is unavailable, then outcome and report work', async () => {
    const evidenceFile = join(sandbox, 'evidence.json');
    writeFileSync(evidenceFile, JSON.stringify(SAMPLES['escalate']));
    const down = await run(
      ['shadow', 'escalate', '--evidence-file', evidenceFile, '--json'],
      dependencies(new Error('x')),
    );
    expect(down.code).toBe(0);
    const entry = JSON.parse(down.output);
    expect(entry.outcome).toBe('unavailable');

    const up = await run(
      ['shadow', 'escalate', '--evidence-file', evidenceFile],
      dependencies(wire({ type: 'noul', noul: 0.97 })),
    );
    expect(up.code).toBe(0);
    expect(up.output).toContain('decided decision=yes');

    const recorded = await run(['outcome', entry.id, '--actual', 'yes'], dependencies(wire({})));
    expect(recorded.code).toBe(0);
    const missing = await run(['outcome', 'zzz', '--actual', 'yes'], dependencies(wire({})));
    expect(missing.code).toBe(1);

    const text = await run(['report'], dependencies(wire({})));
    expect(text.output).toContain('escalate count=2');
    const json = await run(['report', '--json'], dependencies(wire({})));
    expect(JSON.parse(json.output)[0].predicate).toBe('escalate');
    const empty = await run(['report'], { logPath: join(sandbox, 'none.jsonl') });
    expect(empty.output).toBe('No shadow calls recorded.');
  });

  test('usage errors', async () => {
    const evidenceFile = join(sandbox, 'bad.json');
    writeFileSync(evidenceFile, '[1]');
    const badJson = join(sandbox, 'broken.json');
    writeFileSync(badJson, '{');
    const cases: string[][] = [
      [],
      ['wat'],
      ['shadow'],
      ['shadow', 'nope', '--evidence-file', evidenceFile],
      ['shadow', 'escalate'],
      ['shadow', 'escalate', '--evidence-file', join(sandbox, 'absent.json')],
      ['shadow', 'escalate', '--evidence-file', evidenceFile],
      ['shadow', 'escalate', '--evidence-file', badJson],
      ['outcome', 'abc'],
      ['outcome', '--actual', 'yes'],
      ['report', '--bogus'],
    ];
    for (const argv of cases)
      expect(await rejectionOf(run(argv, dependencies(wire({}))))).toBeInstanceOf(UsageError);
  });
});
