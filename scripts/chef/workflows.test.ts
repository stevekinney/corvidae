import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const workflowsDirectory = join(root, '.claude', 'workflows');
const protocolPath = join(root, '.agents', 'skills', 'chef', 'references', 'codex-protocol.md');

const workflowFiles = readdirSync(workflowsDirectory).filter((name) => name.endsWith('.js'));

type Responses = Record<string, unknown>;
const dispatchBase = 'a'.repeat(40);

interface Call {
  prompt: string;
  label: string;
  options: { phase: string; label: string; agentType?: string; model?: string };
}

interface DeliveryResult {
  status: string;
  reason?: string;
  head?: string | null;
  steps: Record<string, unknown>;
  evidenceRequest: Record<string, unknown> | null;
}

/** What each step returns when the script ran clean: the stubs a test overrides by label word. */
const cleanResponses: Responses = {
  'fetch base': { exitCode: 0, base: dispatchBase },
  critique: {
    rows: [
      {
        id: '11a',
        board: 'Runs',
        text: 'Runs as cards',
        states: [{ route: '/runs', state: 'ready', kind: 'ready' }],
      },
    ],
    checked: [{ literal: '700px', result: 'consistent' }],
    conflicts: [],
  },
  resolve: { exitCode: 0 },
  'record override': { recorded: true, path: '/main/tmp/chef/events.jsonl' },
  implement: {
    status: 'ready-for-review',
    startingBase: dispatchBase,
    head: 'abc',
    branch: 'chef/cor-7',
    worktree: '/worktree',
    report: '',
  },
  checks: { exitCode: 0, line: 'focused checks: ok', head: 'abc' },
  dispatch: {
    dispatched: true,
    runId: '99',
    headSha: 'abc',
    url: 'https://github.com/stevekinney/corvidae/actions/runs/99',
    ref: 'chef/cor-7',
    inputs: { unitWorkspace: 'scripts' },
    command: ['bun', 'scripts/chef/targeted-run.ts'],
    requiresFullRun: false,
  },
  wait: { run: '99', headSha: 'abc', conclusion: 'success', jobs: [] },
  compare: {
    run: '99',
    headSha: 'abc',
    conclusion: 'success',
    complete: true,
    noEvidence: false,
    hasNew: false,
  },
  review: { status: 'conforms', departures: [], evidencePath: 'tmp/chef/review.md' },
  classify: { classes: [], seenOnBranch: [] },
  correct: {
    status: 'ready-for-review',
    head: 'def',
    report: '',
    regressionTest: { path: 'scripts/chef/x.test.ts', failsOn: 'abc', passesOn: 'def' },
  },
  'class-fix': {
    status: 'ready-for-review',
    head: 'def',
    report: '',
    regressionTest: { path: 'scripts/chef/x.test.ts', failsOn: 'abc', passesOn: 'def' },
    entryPoints: ['entry point a', 'entry point b'],
  },
  pin: {
    priorExitCode: 1,
    priorHead: 'abc',
    newExitCode: 0,
    newHead: 'def',
    priorOutput: 'scripts/chef/x.test.ts:\n(fail) a > b [1ms]\n',
  },
};

const briefRecord = (issue = 'COR-7', fields: Record<string, unknown> = {}) => ({
  validated: true,
  exitCode: 0,
  briefPath: `/main/tmp/chef/briefs/${issue}.md`,
  base: dispatchBase,
  route: 'branch',
  ...fields,
});
const refusedBrief = (error = 'COR-1 blocks COR-7') =>
  briefRecord('COR-7', { exitCode: 1, briefPath: '', error });

/** The head of round `count`: the worker pushes `abc`, and its one correction pushes `def`. */
const head = (count: number) => (count === 1 ? 'abc' : 'def');

/** A stub that answers each round with `fields` and the commit that round pushed. */
const perRound = (fields: Record<string, unknown>) => (count: number) => ({
  ...fields,
  headSha: head(count),
});

/**
 * Evaluates `deliver-issue.js` the way the workflow runtime does (no Node APIs, only `args`,
 * `agent`, `phase`, `log`, `parallel` and `pipeline`), answering each `agent()` call with the stub
 * whose key is the longest prefix of that call's label, a function of the call number for that key.
 */
async function runDelivery(arguments_: Record<string, unknown> = {}, stubs: Responses = {}) {
  const run = await runWorkflow(
    'deliver-issue.js',
    cleanResponses,
    {
      issues: ['COR-7'],
      run: 'run-1',
      preparedBriefs: Object.fromEntries(
        (Array.isArray(arguments_['issues']) ? arguments_['issues'] : ['COR-7']).map(
          (issue: string) => [issue, briefRecord(issue)],
        ),
      ),
      ...arguments_,
    },
    stubs,
  );
  return { ...run, result: run.result as DeliveryResult[] };
}

async function runWorkflow(
  file: string,
  base: Responses,
  workflowArguments: Record<string, unknown>,
  stubs: Responses,
) {
  const source = readFileSync(join(workflowsDirectory, file), 'utf8').replace(
    /^export const meta = \{[\s\S]*?^};\n/m,
    '',
  );
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const responses = { ...base, ...stubs };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...arguments_: string[]
  ) => (...arguments_: unknown[]) => Promise<unknown>;
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', 'pipeline', source);
  const result = await run(
    workflowArguments,
    async (prompt: string, options: Call['options']) => {
      calls.push({ prompt, label: options.label, options });
      const key = Object.keys(responses)
        .filter((candidate) => options.label.startsWith(candidate))
        .toSorted((left, right) => right.length - left.length)[0];
      if (key === undefined) throw new Error(`no stub for ${options.label}`);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      const stub = responses[key];
      const answer =
        typeof stub === 'function'
          ? (stub as (count: number, label: string) => unknown)(count, options.label)
          : stub;
      // The checks step also reports whether the worker's report stands; a clean run says it does.
      return key === 'checks' && typeof answer === 'object' && answer !== null
        ? { reportOk: true, ...answer }
        : answer;
    },
    () => undefined,
    () => undefined,
    async (tasks: (() => Promise<unknown>)[]) => Promise.all(tasks.map((task) => task())),
    async () => {
      throw new Error('deliver-issue.js does not use pipeline');
    },
  );
  const labels = calls.map((call) => call.label.split(' ')[0]);
  return { calls, labels, result };
}

/** The text of the object literal after `export const meta = `, found by brace matching. */
function metaText(source: string): string {
  const start = source.indexOf('{');
  let depth = 0;
  let inString: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString !== null) {
      if (character === '\\') index += 1;
      else if (character === inString) inString = null;
    } else if (character === "'" || character === '"') inString = character;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('meta object is not closed');
}

describe('workflow scripts', () => {
  test('there are workflows to check', () => {
    expect(workflowFiles).toContain('deliver-issue.js');
    expect(workflowFiles).toContain('answer-threads.js');
  });

  for (const file of workflowFiles) {
    const source = readFileSync(join(workflowsDirectory, file), 'utf8');

    describe(file, () => {
      test('starts with a pure-literal meta', () => {
        expect(source.startsWith('export const meta = {')).toBe(true);
        const text = metaText(source);
        expect(text).not.toContain('`');
        expect(text).not.toContain('${');
        expect(text).not.toMatch(/[A-Za-z_$][\w$]*\s*\(/);
      });

      test('every phase() title is declared in meta.phases', () => {
        const declared = [...metaText(source).matchAll(/phases:\s*\[([^\]]*)\]/g)]
          .flatMap((match) => [...match[1]!.matchAll(/'([^']+)'/g)])
          .map((match) => match[1]!);
        const used = [...source.matchAll(/\bphase\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]!);
        expect(used.length).toBeGreaterThan(0);
        for (const title of used) expect(declared).toContain(title);
      });

      test('uses no nondeterministic primitives', () => {
        expect(source).not.toContain('Date.now');
        expect(source).not.toContain('Math.random');
        expect(source).not.toContain('new Date(');
      });

      test('never asks an agent to merge', () => {
        expect(source).not.toContain('gh pr merge');
        for (const line of source.split('\n')) {
          if (!line.includes('deliver.ts')) continue;
          // A mention that forbids delivery, or sits in a comment, is allowed.
          expect(/\b(never|not)\b|^\s*\/\//i.test(line)).toBe(true);
        }
      });

      // An agent call is a read-only lookup (`model: 'haiku'`, asked to push or commit nothing), a
      // review (`stickler`), or an implementation, which must run as `chef-worker`: a
      // `general-purpose` worker starts near 69K tokens of context against 18K (COR-2372).
      test('dispatches every implementation to the chef-worker agent type', () => {
        const calls = source.split(/\bagent\(/).slice(1);
        expect(calls.length).toBeGreaterThan(0);
        let implementations = 0;
        for (const chunk of calls) {
          // The call runs to its closing `);`; its options object is the part from `label:` on.
          const call = chunk.slice(0, chunk.search(/\)\s*;/));
          const start = call.lastIndexOf('label:');
          expect(start).toBeGreaterThan(0);
          const prompt = call.slice(0, start);
          const options = call.slice(start);
          const agentType = /agentType:\s*'([^']+)'/.exec(options)?.[1];
          // A typed agent takes its model from its frontmatter, except the implementing worker and
          // its correction, whose model is the rule's choice.
          if (agentType === 'chef-worker' && file === 'deliver-issue.js')
            expect(options).toMatch(/\bmodel:\s*(chosen\.model|model),?\s*\}/);
          else if (agentType !== undefined) expect(options).not.toMatch(/\bmodel:/);
          // The two read-only reviewers: the contract check and the pre-build design critique.
          if (agentType === 'stickler' || agentType === 'design-reviewer') continue;
          if (agentType === undefined && /model:\s*'haiku'/.test(options)) {
            expect(prompt).not.toMatch(/\b(push|commit)\b/i);
            continue;
          }
          implementations += 1;
          expect(agentType, prompt.slice(0, 120)).toBe('chef-worker');
        }
        expect(implementations).toBeGreaterThan(0);
      });

      test('names only scripts and agent types that exist', () => {
        for (const match of source.matchAll(/scripts\/chef\/([\w-]+)\.ts/g)) {
          expect(existsSync(join(root, 'scripts', 'chef', `${match[1]}.ts`))).toBe(true);
        }
        for (const match of source.matchAll(/agentType:\s*'([^']+)'/g)) {
          expect(existsSync(join(root, '.claude', 'agents', `${match[1]}.md`))).toBe(true);
        }
      });
    });
  }

  // The default path is a branch the coordinator lands: the worker pushes and opens no pull request.
  test('deliver-issue.js asks its implement dispatch for a pushed branch, not a pull request', () => {
    const source = readFileSync(join(workflowsDirectory, 'deliver-issue.js'), 'utf8');
    const call = source.slice(source.indexOf('const built = await agent('));
    const prompt = call.slice(0, call.indexOf('label:'));
    expect(prompt).toContain('branch path');
    expect(prompt).toContain('open no pull request');
  });

  // #1305 review: the brief promised "A merged pull request." would be delivered as one, but no
  // step took that route. The route `brief.ts --json` reports is the route the worker and the
  // evidence request take.
  test('a brief whose route is a pull request is implemented and delivered as one', async () => {
    const delivery = await runDelivery({
      preparedBriefs: { 'COR-7': briefRecord('COR-7', { route: 'pull-request' }) },
    });
    const implement = delivery.calls.find((call) => call.label.startsWith('implement'));
    expect(implement?.prompt).toContain('pull-request route');
    expect(implement?.prompt).toContain('open a pull request');
    expect(implement?.prompt).not.toContain('open no pull request');
    expect(delivery.result[0]?.evidenceRequest?.['route']).toBe('pull-request');
    const branch = await runDelivery();
    expect(branch.result[0]?.evidenceRequest?.['route']).toBe('branch');
  });

  test('a brief that names no delivery route dispatches no worker', async () => {
    for (const route of [undefined, 'merge']) {
      const delivery = await runDelivery({
        preparedBriefs: { 'COR-7': briefRecord('COR-7', { route }) },
      });
      expect(delivery.calls).toHaveLength(0);
      expect(delivery.result[0]?.reason).toContain('delivery route');
    }
  });

  test('fetches the default branch before dispatch and gates the native checkout on that SHA', async () => {
    const delivery = await runDelivery();
    expect(delivery.calls.slice(0, 2).map((call) => call.label)).toEqual([
      'fetch base COR-7',
      'implement COR-7',
    ]);
    expect(delivery.calls[0]?.prompt).toContain('git fetch');
    expect(delivery.calls[1]?.prompt).toContain('git rev-parse --verify HEAD');
    expect(delivery.calls[1]?.prompt).toContain(dispatchBase);
    expect(delivery.result[0]?.evidenceRequest?.['startingBase']).toBe(dispatchBase);
  });

  test('accepts a validated brief when its commit SHA is uppercase', async () => {
    const delivery = await runDelivery({
      preparedBriefs: { 'COR-7': briefRecord('COR-7', { base: dispatchBase.toUpperCase() }) },
    });
    expect(delivery.calls[1]?.label).toBe('implement COR-7');
    expect(delivery.result[0]?.evidenceRequest?.['startingBase']).toBe(dispatchBase);
  });

  test('refuses dispatch when the fetched SHA differs from the validated brief or fetch failed', async () => {
    for (const fetch of [
      { exitCode: 0, base: 'b'.repeat(40) },
      { exitCode: 1, base: dispatchBase },
    ]) {
      const delivery = await runDelivery({}, { 'fetch base': fetch });
      expect(delivery.calls.map((call) => call.label)).toEqual(['fetch base COR-7']);
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      expect(delivery.result[0]?.evidenceRequest).toBeNull();
    }
  });

  // P-COR-128: COR-2693 never started because main moved past the brief's base while the run went
  // on, though the owner decision of 2026-11-21 says a moved base needs no new evidence run. A base
  // the fetched branch descends from is accepted; only a changed issue body refuses.
  const moved = 'b'.repeat(40);
  for (const [name, fetch, accepted] of [
    [
      'an ancestor base and an unchanged issue body',
      { exitCode: 0, base: moved, ancestor: true, briefDigest: 'd1', currentDigest: 'd1' },
      true,
    ],
    [
      'a base the fetched branch does not descend from',
      { exitCode: 0, base: moved, ancestor: false, briefDigest: 'd1', currentDigest: 'd1' },
      false,
    ],
    [
      'an issue body changed since the brief',
      { exitCode: 0, base: moved, ancestor: true, briefDigest: 'd1', currentDigest: 'd2' },
      false,
    ],
    [
      'an issue digest that could not be read',
      { exitCode: 0, base: moved, ancestor: true, briefDigest: 'd1' },
      false,
    ],
  ] as [string, Record<string, unknown>, boolean][]) {
    test(`a moved default branch with ${name} ${accepted ? 'dispatches' : 'refuses'}`, async () => {
      const delivery = await runDelivery({}, { 'fetch base': fetch });
      const prompt = delivery.calls[0]?.prompt ?? '';
      expect(prompt).toContain(`git merge-base --is-ancestor ${dispatchBase}`);
      expect(prompt).toContain('/main/tmp/chef/briefs/COR-7.md');
      expect(prompt).toContain('bun scripts/chef/brief.ts COR-7 --stdout --run run-1');
      if (accepted) {
        expect(delivery.labels[1]).toBe('implement');
        expect(delivery.result[0]?.status).toBe('READY_TO_LAND');
      } else {
        expect(delivery.labels).toEqual(['fetch']);
        expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      }
    });
  }

  // The native worktree may start at the fetched tip rather than the brief's base; either is the
  // accepted base once the moved base passed, and a third commit is still refused.
  test('a moved base accepts a worker started at the fetched tip, and refuses any other start', async () => {
    const fetch = {
      exitCode: 0,
      base: moved,
      ancestor: true,
      briefDigest: 'd1',
      currentDigest: 'd1',
    };
    const atTip = await runDelivery(
      {},
      {
        'fetch base': fetch,
        implement: { ...(cleanResponses['implement'] as object), startingBase: moved },
      },
    );
    expect(atTip.calls[1]?.prompt).toContain(moved);
    expect(atTip.calls[1]?.prompt).toContain(dispatchBase);
    expect(atTip.result[0]?.status).toBe('READY_TO_LAND');
    expect(atTip.result[0]?.evidenceRequest?.['startingBase']).toBe(moved);
    const elsewhere = await runDelivery(
      {},
      {
        'fetch base': fetch,
        implement: { ...(cleanResponses['implement'] as object), startingBase: 'c'.repeat(40) },
      },
    );
    expect(elsewhere.result[0]?.reason).toContain('worktree started');
  });

  test('refuses dispatch when the fetch succeeds without a full commit SHA', async () => {
    for (const fetch of [{ exitCode: 0 }, { exitCode: 0, base: 'main' }]) {
      const delivery = await runDelivery({}, { 'fetch base': fetch });
      expect(delivery.calls.map((call) => call.label)).toEqual(['fetch base COR-7']);
      expect(delivery.result[0]?.reason).toContain('did not return a commit SHA');
      expect(delivery.result[0]?.evidenceRequest).toBeNull();
    }
  });

  test('refuses evidence when the native worktree starts from a different SHA', async () => {
    const delivery = await runDelivery(
      {},
      {
        implement: { ...(cleanResponses['implement'] as object), startingBase: 'b'.repeat(40) },
      },
    );
    expect(delivery.labels).toEqual(['fetch', 'implement']);
    const mismatchInstruction = delivery.calls[1]?.prompt.split('\n')[0];
    expect(mismatchInstruction).toContain('status blocked');
    for (const field of ['startingBase', 'head', 'branch', 'worktree', 'report']) {
      expect(mismatchInstruction).toContain(field);
    }
    expect(delivery.result[0]?.reason).toContain('worktree started');
    expect(delivery.result[0]?.evidenceRequest).toBeNull();
  });

  // Models come from agent frontmatter alone, so a file without `model:` runs on whatever the
  // session uses (a reviewer definition without one drifted that way).
  test('every agent file names its model', () => {
    const agentsDirectory = join(root, '.claude', 'agents');
    const files = readdirSync(agentsDirectory).filter((name) => name.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(
        readFileSync(join(agentsDirectory, file), 'utf8'),
      )?.[1];
      expect(frontmatter, file).toBeDefined();
      expect(frontmatter, file).toMatch(/^model:\s*\S+/m);
    }
  });

  test('deliver-issue.js drives checks and review before dispatch, wait and compare to a recorded evidence request', async () => {
    const delivery = await runDelivery();
    expect(delivery.labels).toEqual([
      'fetch',
      'implement',
      'checks',
      'review',
      'dispatch',
      'wait',
      'compare',
    ]);
    const [landing] = delivery.result;
    expect(landing?.status).toBe('READY_TO_LAND');
    expect(landing?.evidenceRequest).toMatchObject({
      issue: 'COR-7',
      run: 'run-1',
      repository: 'stevekinney/corvidae',
      revision: 'abc',
      branch: 'chef/cor-7',
      ciRun: '99',
      checks: 'focused checks: ok',
      comparison: { complete: true, noEvidence: false, hasNew: false },
      review: { verdict: 'conforms', evidencePath: 'tmp/chef/review.md', unverifiable: [] },
      override: null,
    });
    const prompts = Object.fromEntries(delivery.calls.map((call) => [call.label, call.prompt]));
    expect(prompts['checks COR-7']).toContain('bun scripts/chef/focused-checks.ts');
    expect(prompts['dispatch COR-7']).toContain('bun scripts/chef/targeted-run.ts --approve');
    expect(prompts['dispatch COR-7']).toContain('bun scripts/chef/targeted-run.ts --decision');
    expect(prompts['dispatch COR-7']).toContain('tmp/chef/review.md');
    expect(prompts['wait COR-7']).toContain('bun scripts/chef/wait-run.ts 99');
    expect(prompts['compare COR-7']).toContain('bun scripts/chef/ci-compare.ts 99');
    expect(delivery.calls.find((call) => call.label.startsWith('review'))?.options.agentType).toBe(
      'stickler',
    );
  });

  // The trial of 2026-11-25 (P-COR-128): the earlier reviewer approved a head whose self-test used a
  // stand-in for the real component; the contract check found it. Every candidate gets the contract
  // check, against the issue's own sections of its brief and the diff from the worker's start.
  test('deliver-issue.js hands the contract check the brief, the diff range and the worktree', async () => {
    const delivery = await runDelivery();
    const review = delivery.calls.find((call) => call.label.startsWith('review'));
    expect(review?.prompt).toContain('/main/tmp/chef/briefs/COR-7.md');
    expect(review?.prompt).toContain(`git diff ${dispatchBase}...abc`);
    expect(review?.prompt).toContain('cd /worktree');
    expect(review?.prompt).not.toMatch(/\bapprove\b/);
  });

  test('a contract check with departures sends them to a correction, and unverifiable criteria travel without blocking', async () => {
    const departed = await runDelivery(
      {},
      { review: { status: 'departures', departures: ['AC1: the self-test uses a stand-in'] } },
    );
    const fix = departed.calls.find((call) => call.label.startsWith('correct'));
    expect(fix?.prompt).toContain('AC1: the self-test uses a stand-in');
    const unverifiable = await runDelivery(
      {},
      {
        review: {
          status: 'conforms',
          departures: [],
          unverifiable: ['AC4: needs a browser'],
          evidencePath: 'tmp/chef/review.md',
        },
      },
    );
    expect(unverifiable.result[0]?.status).toBe('READY_TO_LAND');
    expect(unverifiable.result[0]?.evidenceRequest?.['review']).toMatchObject({
      unverifiable: ['AC4: needs a browser'],
    });
  });

  test('a local approval without an evidence reference cannot start discretionary CI', async () => {
    const delivery = await runDelivery({}, { review: { status: 'conforms', departures: [] } });
    expect(delivery.labels).toEqual(['fetch', 'implement', 'checks', 'review']);
    expect(delivery.result[0]?.reason).toContain('did not return an evidence reference');
  });

  // A worker's report gates landing, not only its stop: the checks step runs `report.ts check`, and
  // a report that is missing, invalid, for another brief version, recorded through the three-blocks
  // escape or for another head comes back as reportOk false.
  test('deliver-issue.js asks for the report check at the pushed head and never lands without it', async () => {
    const clean = await runDelivery();
    const checkPrompt = clean.calls.find((call) => call.label.startsWith('checks'))?.prompt ?? '';
    expect(checkPrompt).toContain('bun scripts/chef/report.ts check COR-7 --head abc');
    for (const problem of [
      'there is no readable report',
      "the worker's stop was let through after the block limit",
      'the report is for head old, not the pushed head abc',
      'the brief was amended after you read it',
    ]) {
      const delivery = await runDelivery(
        {},
        {
          checks: {
            exitCode: 0,
            line: 'ok',
            head: 'abc',
            reportOk: false,
            reportProblems: [problem],
          },
        },
      );
      expect(delivery.labels).toEqual(['fetch', 'implement', 'checks']);
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      expect(delivery.result[0]?.reason).toContain(problem);
      expect(delivery.result[0]?.evidenceRequest).toBeNull();
    }
  });

  test('deliver-issue.js sends the correction worker its brief path, the corrections and the report command', async () => {
    const delivery = await runDelivery(
      {},
      { review: { status: 'departures', departures: ['a defect'] } },
    );
    const prompt = delivery.calls.find((call) => call.label.startsWith('correct'))?.prompt ?? '';
    expect(prompt).toContain('tmp/chef/briefs/COR-7.md');
    expect(prompt).toContain('corrections/COR-7.jsonl');
    expect(prompt).toContain('bun scripts/chef/report.ts write COR-7');
  });

  test('deliver-issue.js stops for judgment, with no evidence request, when the run needs a full run', async () => {
    const delivery = await runDelivery(
      {},
      {
        dispatch: {
          dispatched: false,
          ref: 'chef/cor-7',
          requiresFullRun: true,
        },
      },
    );
    expect(delivery.labels).toEqual(['fetch', 'implement', 'checks', 'review', 'dispatch']);
    expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
    expect(delivery.result[0]?.evidenceRequest).toBeNull();
  });

  // The P-COR-128 trial: COR-2691 and COR-2694 came back from focused checks "0 failed, N pending"
  // (a pool slot not granted, exit 75). The workflow sent each to a correction that demanded a
  // failing-first test for a defect that did not exist (995K workflow tokens, two NEEDS_JUDGMENT).
  // A pending stage with nothing failed is run directly instead, and never corrected.
  const pendingCommand = 'env SELECTION=d bunx turbo run test:self --filter=//';
  const pendingChecks = {
    exitCode: 1,
    line: 'focused-checks: 5 passed, 0 failed, 1 pending (tests:root)',
    head: 'abc',
    pending: [pendingCommand],
  };

  test('deliver-issue.js runs a pending stage directly instead of correcting it', async () => {
    const delivery = await runDelivery(
      {},
      {
        checks: pendingChecks,
        pending: { head: 'abc', results: [{ command: pendingCommand, exitCode: 0 }] },
      },
    );
    expect(delivery.labels).toEqual([
      'fetch',
      'implement',
      'checks',
      'pending',
      'review',
      'dispatch',
      'wait',
      'compare',
    ]);
    const prompt = delivery.calls.find((call) => call.label.startsWith('pending'))?.prompt ?? '';
    expect(prompt).toContain(pendingCommand);
    expect(prompt).toContain('cd /worktree');
    expect(delivery.result[0]?.status).toBe('READY_TO_LAND');
  });

  test('deliver-issue.js corrects a pending stage only when it fails once run', async () => {
    const delivery = await runDelivery(
      {},
      {
        checks: pendingChecks,
        pending: { head: 'abc', results: [{ command: pendingCommand, exitCode: 1 }] },
      },
    );
    expect(delivery.labels).toContain('correct');
    const fix = delivery.calls.find((call) => call.label.startsWith('correct'))?.prompt ?? '';
    expect(fix).toContain(pendingCommand);
  });

  for (const [name, stubs] of [
    [
      'a pending stage still not admitted',
      {
        checks: pendingChecks,
        pending: { head: 'abc', results: [{ command: pendingCommand, exitCode: 75 }] },
      },
    ],
    // Codex on #1305: a pending stage whose child a signal ends (`run-exclusively.ts` returns
    // 128 + the signal number) gave no verdict, so it is no defect to correct.
    [
      'a pending stage a signal ended (exit 143)',
      {
        checks: pendingChecks,
        pending: { head: 'abc', results: [{ command: pendingCommand, exitCode: 143 }] },
      },
    ],
    [
      'a pending stage reported killed by a signal',
      {
        checks: pendingChecks,
        pending: {
          head: 'abc',
          results: [{ command: pendingCommand, exitCode: 1, signal: 'SIGTERM' }],
        },
      },
    ],
    [
      'a hung step with nothing failed',
      {
        checks: { exitCode: 4, line: 'focused-checks: 4 passed, 0 failed, 1 hung', head: 'abc' },
      },
    ],
  ] as [string, Responses][]) {
    test(`deliver-issue.js sends ${name} to judgment, never to a correction`, async () => {
      const delivery = await runDelivery({}, stubs);
      expect(delivery.labels).not.toContain('correct');
      expect(delivery.labels).not.toContain('classify');
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      expect(delivery.result[0]?.reason).toContain('no verdict');
    });
  }

  test('deliver-issue.js re-runs the checks after one correction and then asks for judgment', async () => {
    const delivery = await runDelivery(
      {},
      { checks: (count: number) => ({ exitCode: 1, line: 'lint failed', head: head(count) }) },
    );
    expect(delivery.labels).toEqual([
      'fetch',
      'implement',
      'checks',
      'classify',
      'correct',
      'pin',
      'checks',
    ]);
    expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
    expect(delivery.result[0]?.reason).toContain('after 1 correction');
  });

  // Round 2 must not land the corrected head with round 1's run.
  test('deliver-issue.js refuses round 1 evidence for the corrected head', async () => {
    const delivery = await runDelivery(
      {},
      {
        review: (count: number) =>
          count === 1
            ? { status: 'departures', departures: ['a defect'] }
            : { status: 'conforms', departures: [], evidencePath: 'tmp/chef/review.md' },
        checks: (count: number) => ({ exitCode: 0, line: 'ok', head: head(count) }),
        dispatch: (count: number) => ({
          ...(cleanResponses['dispatch'] as object),
          headSha: 'abc',
          runId: String(98 + count),
        }),
      },
    );
    expect(delivery.labels.at(-1)).toBe('dispatch');
    expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
    expect(delivery.result[0]?.reason).toContain('not the pushed head def');
    expect(delivery.result[0]?.evidenceRequest).toBeNull();
  });

  for (const [step, stubs, stoppedAfter] of [
    ['checks', { checks: { exitCode: 0, line: 'ok', head: 'old' } }, 'checks'],
    [
      'dispatch',
      { dispatch: { ...(cleanResponses['dispatch'] as object), headSha: 'old' } },
      'dispatch',
    ],
    ['wait', { wait: { run: '99', headSha: 'old', conclusion: 'success' } }, 'wait'],
    [
      'compare',
      { compare: { ...(cleanResponses['compare'] as object), headSha: 'old' } },
      'compare',
    ],
  ] as [string, Responses, string][]) {
    test(`deliver-issue.js stops for judgment when the ${step} step is for another commit`, async () => {
      const delivery = await runDelivery({}, stubs);
      expect(delivery.labels.at(-1)).toBe(stoppedAfter);
      expect(delivery.labels.includes('review')).toBe(step !== 'checks');
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      expect(delivery.result[0]?.evidenceRequest).toBeNull();
    });
  }

  // Each gate, alone, keeps a branch from READY_TO_LAND even though every other step is clean.
  for (const [name, stubs] of [
    [
      'new failures against main',
      { compare: perRound({ ...(cleanResponses['compare'] as object), hasNew: true }) },
    ],
    [
      'an empty run',
      { compare: perRound({ ...(cleanResponses['compare'] as object), noEvidence: true }) },
    ],
    [
      'an incomplete run',
      { compare: perRound({ ...(cleanResponses['compare'] as object), complete: false }) },
    ],
    ['a blocked review', { review: { status: 'departures', departures: ['a defect'] } }],
  ] as [string, Responses][]) {
    test(`deliver-issue.js sends ${name} to one correction, then to judgment`, async () => {
      const delivery = await runDelivery(
        {},
        {
          dispatch: perRound(cleanResponses['dispatch'] as Record<string, unknown>),
          wait: perRound(cleanResponses['wait'] as Record<string, unknown>),
          compare: perRound(cleanResponses['compare'] as Record<string, unknown>),
          checks: (count: number) => ({ exitCode: 0, line: 'ok', head: head(count) }),
          ...stubs,
        },
      );
      expect(delivery.labels.filter((label) => label === 'correct')).toHaveLength(1);
      expect(delivery.labels.filter((label) => label === 'checks')).toHaveLength(2);
      if (name === 'a blocked review') expect(delivery.labels).not.toContain('dispatch');
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      expect(delivery.result[0]?.reason).toContain('after 1 correction');
      expect(delivery.result[0]?.evidenceRequest).toBeNull();
    });
  }

  // One blocked review forces one correction, so the run shows the model of both worker calls.
  async function runWithCorrection(
    arguments_: Record<string, unknown>,
    stubs: Responses = {},
  ): ReturnType<typeof runDelivery> {
    return runDelivery(arguments_, {
      review: (count: number) =>
        count === 1
          ? { status: 'departures', departures: ['a defect'] }
          : { status: 'conforms', departures: [], evidencePath: 'tmp/chef/review.md' },
      checks: (count: number) => ({ exitCode: 0, line: 'ok', head: head(count) }),
      dispatch: { ...(cleanResponses['dispatch'] as object), headSha: head(2) },
      wait: { ...(cleanResponses['wait'] as object), headSha: head(2) },
      compare: { ...(cleanResponses['compare'] as object), headSha: head(2) },
      ...stubs,
    });
  }

  const modelOf = (calls: Call[], word: string) =>
    calls.filter((call) => call.label.startsWith(word)).map((call) => call.options.model);

  test('deliver-issue.js gives mechanical work to Sonnet, in the implementation and its correction', async () => {
    const delivery = await runWithCorrection({
      paths: { 'COR-7': ['scripts/chef/brief.ts', 'components/cinder/package.json'] },
    });
    expect(modelOf(delivery.calls, 'implement')).toEqual(['sonnet']);
    expect(modelOf(delivery.calls, 'correct')).toEqual(['sonnet']);
    expect(delivery.result[0]?.status).toBe('READY_TO_LAND');
    expect(delivery.result[0]?.evidenceRequest?.['workerModel']).toMatchObject({
      model: 'sonnet',
      rule: expect.stringContaining('no design-heavy'),
    });
  });

  for (const path of [
    'applications/interborough/src/routes/runs/+page.svelte',
    'applications/interborough/src/styles/tokens.css',
    'components/cinder/src/components/button/button.svelte',
  ]) {
    test(`deliver-issue.js gives interface work to Opus when the issue owns ${path}`, async () => {
      for (const where of ['args', 'brief']) {
        const delivery =
          where === 'args'
            ? await runWithCorrection({ paths: { 'COR-7': [path] } })
            : await runWithCorrection({
                preparedBriefs: { 'COR-7': briefRecord('COR-7', { paths: [path] }) },
              });
        expect(modelOf(delivery.calls, 'implement')).toEqual(['opus']);
        expect(modelOf(delivery.calls, 'correct')).toEqual(['opus']);
        expect(delivery.result[0]?.evidenceRequest?.['workerModel']).toMatchObject({
          model: 'opus',
          rule: expect.stringContaining(path),
        });
      }
    });
  }

  test('deliver-issue.js gives an issue to Opus when args.models names it, and no other issue', async () => {
    const delivery = await runDelivery({
      issues: ['COR-7', 'COR-8'],
      models: { 'COR-7': 'opus' },
    });
    const byIssue = (issue: string) =>
      delivery.calls.filter((call) => call.label === `implement ${issue}`);
    expect(byIssue('COR-7').map((call) => call.options.model)).toEqual(['opus']);
    expect(byIssue('COR-8').map((call) => call.options.model)).toEqual(['sonnet']);
    expect(delivery.result[0]?.evidenceRequest?.['workerModel']).toMatchObject({
      model: 'opus',
      rule: expect.stringContaining('args.models'),
    });
  });

  test('deliver-issue.js leaves the reviewer on its frontmatter model and the checks on Haiku', async () => {
    const delivery = await runWithCorrection({ models: { 'COR-7': 'opus' } });
    expect(modelOf(delivery.calls, 'review')).toEqual([undefined, undefined]);
    for (const word of ['checks', 'dispatch', 'wait', 'compare'])
      for (const model of modelOf(delivery.calls, word)) expect(model).toBe('haiku');
  });

  test('deliver-issue.js stops for judgment when the evidence run was not dispatched', async () => {
    const delivery = await runDelivery(
      {},
      { dispatch: { ...(cleanResponses['dispatch'] as object), dispatched: false } },
    );
    expect(delivery.labels).toEqual(['fetch', 'implement', 'checks', 'review', 'dispatch']);
    expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
  });

  test('deliver-issue.js hands the worker the coordinator’s brief after fetching its base', async () => {
    const path = '/coordinator/verified/brief for COR-7.md';
    const delivery = await runDelivery({
      preparedBriefs: { 'COR-7': briefRecord('COR-7', { briefPath: path }) },
    });
    expect(delivery.labels.slice(0, 2)).toEqual(['fetch', 'implement']);
    expect(delivery.calls[1]?.prompt).toContain(`brief file ${path} and nothing else`);
  });

  test('deliver-issue.js dispatches no worker for missing, malformed, or refused preparation', async () => {
    for (const brief of [
      undefined,
      { validated: true, exitCode: 0 },
      briefRecord('COR-7', { validated: false }),
      briefRecord('COR-7', { briefPath: 'relative/brief.md' }),
      briefRecord('COR-7', { base: undefined }),
      refusedBrief('repository pin does not match origin'),
      refusedBrief('required context is unreadable'),
    ]) {
      const delivery = await runDelivery({ preparedBriefs: { 'COR-7': brief } });
      expect(delivery.calls).toHaveLength(0);
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
    }
  });

  describe('the pre-build design critique', () => {
    const designArguments = {
      preparedBriefs: {
        'COR-7': { ...refusedBrief('design rows are not resolved'), needsResolvedRows: true },
      },
      resolvedBriefs: { 'COR-7': briefRecord() },
    };

    test('critiques and resolves design rows before dispatching from the supplied resolved brief', async () => {
      const delivery = await runDelivery(designArguments);
      expect(delivery.labels.slice(0, 4)).toEqual(['critique', 'resolve', 'fetch', 'implement']);
      const critique = delivery.calls[0];
      expect(critique?.options.agentType).toBe('design-reviewer');
      expect(critique?.options.model).toBeUndefined();
      expect(critique?.prompt).toContain('bun scripts/chef/design-critique.ts rows COR-7');
      const resolve = delivery.calls[1];
      expect(resolve?.prompt).toContain('bun scripts/chef/design-critique.ts write COR-7 --input');
      expect(resolve?.prompt).toContain(
        '"states":[{"route":"/runs","state":"ready","kind":"ready"}]',
      );
      expect(delivery.result[0]?.status).toBe('READY_TO_LAND');
    });

    test('hands the critique the coordinator’s verified design context, or says there is none', async () => {
      const withContext = await runDelivery({
        ...designArguments,
        verifiedContexts: { 'COR-7': '/main/tmp/chef/context.json' },
      });
      expect(withContext.calls[0]?.prompt).toContain('/main/tmp/chef/context.json');
      const without = await runDelivery(designArguments);
      expect(without.calls[0]?.prompt).toContain('supplied no design context file');
    });

    test('stops for judgment, building nothing, when the file was refused', async () => {
      const delivery = await runDelivery(designArguments, {
        resolve: { exitCode: 1, error: 'row 11a declares no states' },
      });
      expect(delivery.labels).toEqual(['critique', 'resolve']);
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      expect(delivery.result[0]?.reason).toContain('row 11a declares no states');
    });

    test('requires a validated resolved brief after a successful critique', async () => {
      const delivery = await runDelivery({ ...designArguments, resolvedBriefs: {} });
      expect(delivery.labels).toEqual(['critique', 'resolve']);
      expect(delivery.result[0]?.reason).toContain('missing validated coordinator brief');
    });

    test('adds no critique for a clean brief or a refusal unrelated to design', async () => {
      const refused = await runDelivery({ preparedBriefs: { 'COR-7': refusedBrief() } });
      expect(refused.calls).toHaveLength(0);
      const clean = await runDelivery();
      expect(clean.labels).not.toContain('critique');
    });
  });

  test('deliver-issue.js records an override and uses only the supplied override brief', async () => {
    const override = { reason: 'the blocker closed in this batch', at: '2026-11-19T10:00:00Z' };
    const delivery = await runDelivery({
      override: { 'COR-7': override },
      preparedBriefs: { 'COR-7': refusedBrief() },
      overrideBriefs: { 'COR-7': briefRecord('COR-7', { bytes: 2048 }) },
    });
    expect(delivery.labels.slice(0, 3)).toEqual(['record', 'fetch', 'implement']);
    const recording = delivery.calls[0]?.prompt ?? '';
    expect(recording).toContain('tmp/chef/events.jsonl');
    const line = /: (\{.*\})\n/.exec(recording)?.[1] ?? '';
    expect(JSON.parse(line)).toEqual({
      event: 'brief-override',
      issue: 'COR-7',
      run: 'run-1',
      reason: override.reason,
      at: override.at,
    });
    expect(delivery.calls[2]?.prompt).toContain('brief file /main/tmp/chef/briefs/COR-7.md ');
    expect(delivery.result[0]?.status).toBe('READY_TO_LAND');
    expect(delivery.result[0]?.evidenceRequest?.['override']).toEqual(override);
  });

  test('deliver-issue.js starts no worker after an override with no usable coordinator brief', async () => {
    const override = { 'COR-7': { reason: 'the blocker closed', at: '2026-11-19T10:00:00Z' } };
    for (const record of [
      undefined,
      briefRecord('COR-7', { bytes: 0 }),
      briefRecord('COR-7', { briefPath: 'relative/brief.md', bytes: 2048 }),
      briefRecord('COR-8', { bytes: 2048 }),
    ]) {
      const delivery = await runDelivery({
        override,
        preparedBriefs: { 'COR-7': refusedBrief() },
        overrideBriefs: { 'COR-7': record },
      });
      expect(delivery.labels).toEqual(['record']);
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
    }
  });

  test('deliver-issue.js applies an override to its own issue only', async () => {
    const delivery = await runDelivery({
      issues: ['COR-7', 'COR-8'],
      preparedBriefs: { 'COR-7': refusedBrief(), 'COR-8': refusedBrief() },
      override: { 'COR-7': { reason: 'closed in this batch', at: '2026-11-19T10:00:00Z' } },
      overrideBriefs: { 'COR-7': briefRecord('COR-7', { bytes: 10 }) },
    });
    const byIssue = (issue: string) => delivery.calls.filter((call) => call.label.endsWith(issue));
    expect(byIssue('COR-8')).toHaveLength(0);
    expect(byIssue('COR-7').map((call) => call.label.split(' ')[0])).toContain('implement');
    expect(delivery.result.map((entry) => entry.status)).toEqual([
      'READY_TO_LAND',
      'NEEDS_JUDGMENT',
    ]);
  });

  test('deliver-issue.js refuses an override without a reason or a time', async () => {
    const delivery = await runDelivery({
      override: { 'COR-7': { reason: ' ', at: '2026-11-19T10:00:00Z' } },
      preparedBriefs: { 'COR-7': refusedBrief() },
    });
    expect(delivery.calls).toHaveLength(0);
    expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
  });

  test('deliver-issue.js refuses an invalid coordinator classification before preparation', async () => {
    const delivery = await runDelivery({ classifications: { 'COR-7': 'no-behavior; touch nope' } });
    expect(delivery.calls).toHaveLength(0);
    expect(delivery.result[0]?.reason).toBe('invalid coordinator classification');
  });

  // One correction path: a coordinator-requested correction skips the brief and the build, and
  // runs classify, correction, pin, checks, evidence, compare and review at the new head.
  const regression = { path: 'scripts/chef/x.test.ts', failsOn: 'abc', passesOn: 'def' };
  const pinned = cleanResponses['pin'] as Record<string, unknown>;
  const afterFix = {
    checks: { exitCode: 0, line: 'focused checks: ok', head: 'def' },
    dispatch: { ...(cleanResponses['dispatch'] as object), headSha: 'def' },
    wait: { ...(cleanResponses['wait'] as object), headSha: 'def' },
    compare: { ...(cleanResponses['compare'] as object), headSha: 'def' },
    classify: { classes: [], seenOnBranch: [] },
    correct: { status: 'ready-for-review', head: 'def', report: '', regressionTest: regression },
    'class-fix': {
      status: 'ready-for-review',
      head: 'def',
      report: '',
      regressionTest: regression,
      entryPoints: ['route a', 'route b'],
    },
    pin: pinned,
  };
  const requested = (correction: Record<string, unknown> = {}) => ({
    issues: [],
    correction: {
      issue: 'COR-7',
      head: 'abc',
      branch: 'chef/cor-7',
      worktree: '/worktree',
      finding: 'the route accepts a negative timeout',
      ...correction,
    },
  });

  test('a coordinator-requested correction runs through the workflow, with no hand-written fix', async () => {
    const delivery = await runDelivery(requested(), afterFix);
    expect(delivery.labels).toEqual([
      'classify',
      'correct',
      'pin',
      'checks',
      'review',
      'dispatch',
      'wait',
      'compare',
    ]);
    const fix = delivery.calls.find((call) => call.label.startsWith('correct'));
    expect(fix?.options.agentType).toBe('chef-worker');
    expect(fix?.prompt).toContain('the route accepts a negative timeout');
    expect(delivery.result[0]).toMatchObject({ status: 'READY_TO_LAND', head: 'def' });
    expect(delivery.result[0]?.evidenceRequest).toMatchObject({ revision: 'def' });
  });

  test('a second finding of one class produces a CLASS_FIX step', async () => {
    const delivery = await runDelivery(requested({ class: 'boundary-validation' }), {
      ...afterFix,
      classify: { classes: ['boundary-validation'], seenOnBranch: ['boundary-validation'] },
    });
    expect(delivery.labels.slice(0, 3)).toEqual(['classify', 'class-fix', 'pin']);
    expect(delivery.labels).not.toContain('correct');
    const prompt = delivery.calls.find((call) => call.label.startsWith('class-fix'))?.prompt;
    expect(prompt).toContain('every entry point');
    expect(delivery.result[0]?.steps['correction1']).toMatchObject({
      kind: 'CLASS_FIX',
      repeated: ['boundary-validation'],
    });
    expect(delivery.result[0]?.status).toBe('READY_TO_LAND');
  });

  test('a class the coordinator names as already seen produces a CLASS_FIX step', async () => {
    const delivery = await runDelivery(requested({ seenClasses: ['state-machine'] }), {
      ...afterFix,
      classify: { classes: ['state-machine'], seenOnBranch: [] },
    });
    expect(delivery.labels[1]).toBe('class-fix');
  });

  test('a first finding of a class gets a point fix, and the branch path classifies too', async () => {
    const delivery = await runWithCorrection(
      {},
      { classify: { classes: ['boundary-validation'], seenOnBranch: [] }, pin: pinned },
    );
    expect(delivery.labels).toContain('classify');
    expect(delivery.labels).toContain('correct');
    expect(delivery.labels).not.toContain('class-fix');
    expect(delivery.labels.indexOf('pin')).toBeGreaterThan(delivery.labels.indexOf('correct'));
  });

  test('a class fix without every entry point listed is refused', async () => {
    const delivery = await runDelivery(requested(), {
      ...afterFix,
      classify: { classes: ['boundary-validation'], seenOnBranch: ['boundary-validation'] },
      'class-fix': { ...afterFix['class-fix'], entryPoints: [] },
    });
    expect(delivery.labels).toEqual(['classify', 'class-fix']);
    expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
    expect(delivery.result[0]?.reason).toContain('entry point');
  });

  for (const [name, stubs] of [
    ['reports none', { correct: { ...afterFix.correct, regressionTest: undefined } }],
    [
      'names a different pre-fix head',
      {
        correct: { ...afterFix.correct, regressionTest: { ...regression, failsOn: 'zzz' } },
        pin: { ...pinned, priorHead: 'zzz' },
      },
    ],
    [
      'names a post-fix head that is not the new head',
      {
        correct: { ...afterFix.correct, regressionTest: { ...regression, passesOn: 'zzz' } },
        pin: { ...pinned, newHead: 'zzz' },
      },
    ],
    ['was run at another pre-fix commit', { pin: { ...pinned, priorHead: 'zzz' } }],
    [
      'comes with a fix that left the head unchanged',
      {
        correct: {
          ...afterFix.correct,
          head: 'abc',
          regressionTest: { ...regression, passesOn: 'abc' },
        },
        pin: { ...pinned, newHead: 'abc' },
      },
    ],
    [
      'is not a test file',
      { correct: { ...afterFix.correct, regressionTest: { ...regression, path: 'a.ts' } } },
    ],
    ['passes on the pre-fix head', { pin: { ...pinned, priorExitCode: 0 } }],
    ['fails on the new head', { pin: { ...pinned, newExitCode: 1 } }],
    ['ran at another commit', { pin: { ...pinned, newHead: 'zzz' } }],
  ] as [string, Responses][]) {
    test(`a correction whose failing-first test ${name} is refused`, async () => {
      const delivery = await runDelivery(requested(), { ...afterFix, ...stubs });
      expect(delivery.labels).not.toContain('checks');
      expect(delivery.labels).not.toContain('dispatch');
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      expect(delivery.result[0]?.reason).toContain('regression test');
      expect(delivery.result[0]?.evidenceRequest).toBeNull();
    });
  }

  // Exit 75 (busy pool) and 70 (hang guard) are not test results, and a failure that names no test
  // in the pinned file is a setup failure: each is "pin did not run", never "pinned".
  for (const [name, pin] of [
    ['a busy pool (75) at the pre-fix head', { ...pinned, priorExitCode: 75 }],
    ['the hang guard (70) at the pre-fix head', { ...pinned, priorExitCode: 70 }],
    ['a busy pool (75) at the new head', { ...pinned, newExitCode: 75 }],
    ['a setup failure (exit 2) at the pre-fix head', { ...pinned, priorExitCode: 2 }],
    [
      'exit 1 with no (fail) line',
      { ...pinned, priorOutput: 'scripts/chef/x.test.ts:\nerror: Cannot find module\n' },
    ],
    ['exit 1 with no output at all', { ...pinned, priorOutput: '' }],
    [
      'a (fail) line in another file',
      { ...pinned, priorOutput: '(fail) a > b [1ms]\nscripts/chef/other.test.ts:\n' },
    ],
  ] as [string, Record<string, unknown>][]) {
    test(`a pin that saw ${name} did not run, so the correction is refused`, async () => {
      const delivery = await runDelivery(requested(), { ...afterFix, pin });
      expect(delivery.labels).not.toContain('checks');
      expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
      expect(delivery.result[0]?.reason).toContain('pin did not run');
    });
  }

  test('the branch path refuses its own correction when the test passes before the fix', async () => {
    const delivery = await runWithCorrection({}, { pin: { ...pinned, priorExitCode: 0 } });
    expect(delivery.labels.filter((label) => label === 'checks')).toHaveLength(1);
    expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
    expect(delivery.result[0]?.reason).toContain('regression test');
  });

  test('a correction request with missing fields is refused before any agent runs', async () => {
    const delivery = await runDelivery(requested({ worktree: '' }), afterFix);
    expect(delivery.calls).toHaveLength(0);
    expect(delivery.result[0]?.status).toBe('NEEDS_JUDGMENT');
  });

  test('the script names exactly the defect classes review-threads tags', () => {
    const source = readFileSync(join(workflowsDirectory, 'deliver-issue.js'), 'utf8');
    const names = (
      JSON.parse(readFileSync(join(root, 'scripts', 'chef', 'defect-classes.json'), 'utf8')) as {
        classes: { name: string }[];
      }
    ).classes.map((entry) => entry.name);
    const listed = /const CLASS_NAMES = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
    expect([...listed.matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual(names);
  });
});

describe('answer-threads.js corrections', () => {
  const answerPin = {
    priorExitCode: 1,
    priorHead: 'abc',
    newExitCode: 0,
    newHead: 'def',
    priorOutput: 'scripts/chef/x.test.ts:\n(fail) a > b [1ms]\n',
  };
  const answerResponses: Responses = {
    triage: {
      threads: [
        { id: 'T1', triage: 'fix' },
        { id: 'T2', triage: 'decline' },
      ],
    },
    classify: { head: 'abc', repeating: [] },
    answer: {
      round: 1,
      answered: ['T1', 'T2'],
      fixedHead: 'def',
      open: [],
      replyFile: 'tmp/replies.tsv',
      regressionTest: { path: 'scripts/chef/x.test.ts', failsOn: 'abc', passesOn: 'def' },
    },
    pin: answerPin,
    resolve: { exitCode: 0, resolved: ['T1', 'T2'] },
  };
  const answerRound = (stubs: Responses = {}) =>
    runWorkflow(
      'answer-threads.js',
      answerResponses,
      { pr: 7, worktree: '/worktree', round: 1 },
      stubs,
    );
  const asRecord = (value: unknown) => value as Record<string, unknown>;

  test('proves the test, then resolves the threads, and returns the fixed head', async () => {
    const round = await answerRound();
    expect(round.labels).toEqual(['triage', 'classify', 'answer', 'pin', 'resolve']);
    expect(asRecord(round.result)['fixedHead']).toBe('def');
    expect(round.calls.find((call) => call.label.startsWith('answer'))?.prompt).toContain(
      'never run `resolve` yourself',
    );
  });

  test('a round that pushed no fix resolves its threads without a pin', async () => {
    const round = await answerRound({
      answer: { round: 1, answered: ['T1'], fixedHead: 'abc', open: [], replyFile: 'r.tsv' },
    });
    expect(round.labels).toEqual(['triage', 'classify', 'answer', 'resolve']);
  });

  for (const [name, stubs] of [
    [
      'no regression test',
      { answer: { ...(answerResponses['answer'] as object), regressionTest: undefined } },
    ],
    [
      'a regression test that fails on another pre-fix head',
      {
        answer: {
          ...(answerResponses['answer'] as object),
          regressionTest: { path: 'scripts/chef/x.test.ts', failsOn: 'zzz', passesOn: 'def' },
        },
      },
    ],
    [
      'a regression test that is not a test file',
      {
        answer: {
          ...(answerResponses['answer'] as object),
          regressionTest: { path: 'scripts/chef/x.ts', failsOn: 'abc', passesOn: 'def' },
        },
      },
    ],
    [
      'a regression test that passes on another head than the pushed one',
      {
        answer: {
          ...(answerResponses['answer'] as object),
          regressionTest: { path: 'scripts/chef/x.test.ts', failsOn: 'abc', passesOn: 'zzz' },
        },
      },
    ],
    ['a test that passes on the pre-fix head', { pin: { ...answerPin, priorExitCode: 0 } }],
    ['a test that fails on the new head', { pin: { ...answerPin, newExitCode: 1 } }],
    ['a pin run at another commit', { pin: { ...answerPin, newHead: 'zzz' } }],
    ['a pin that exited 75 (busy pool)', { pin: { ...answerPin, priorExitCode: 75 } }],
    ['a pin that exited 70 (hang guard)', { pin: { ...answerPin, newExitCode: 70 } }],
    ['a pin whose failure names no test in the file', { pin: { ...answerPin, priorOutput: '' } }],
    [
      'answered threads with no reply file',
      { answer: { ...(answerResponses['answer'] as object), replyFile: undefined } },
    ],
  ] as [string, Responses][]) {
    test(`refuses ${name}: no thread is resolved, and fixedHead is null`, async () => {
      const round = await answerRound(stubs);
      expect(round.labels).not.toContain('resolve');
      expect(round.result).toMatchObject({
        status: 'NEEDS_JUDGMENT',
        fixedHead: null,
        pushedHead: 'def',
        answered: [],
        open: ['T1', 'T2'],
      });
      expect(asRecord(round.result)['reason']).toEqual(expect.any(String));
    });
  }

  test('a pin that exited 75 is reported as not run', async () => {
    const round = await answerRound({ pin: { ...answerPin, priorExitCode: 75 } });
    expect(asRecord(round.result)['reason']).toContain('pin did not run');
  });

  test('a repeated class runs CLASS_FIX, and refuses a fix that lists no entry points', async () => {
    const repeated = { classify: { head: 'abc', repeating: ['state-machine'] } };
    const refused = await answerRound(repeated);
    const prompt = refused.calls.find((call) => call.label.startsWith('answer'))?.prompt;
    expect(prompt).toContain('CLASS_FIX');
    expect(prompt).toContain('every entry point');
    expect(refused.labels).not.toContain('resolve');
    expect(asRecord(refused.result)['reason']).toContain('entry point');
    const accepted = await answerRound({
      ...repeated,
      answer: {
        ...(answerResponses['answer'] as object),
        entryPoints: ['hook a', 'hook b'],
      },
    });
    expect(accepted.labels).toContain('resolve');
    const pointFix = await answerRound();
    expect(pointFix.calls.find((call) => call.label.startsWith('answer'))?.prompt).not.toContain(
      'CLASS_FIX',
    );
  });
});

describe('codex-protocol.md', () => {
  const text = readFileSync(protocolPath, 'utf8');

  test('names only scripts and agents that exist', () => {
    const names = [...text.matchAll(/scripts\/chef\/([\w-]+)\.ts/g)];
    expect(names.length).toBeGreaterThan(0);
    for (const match of names) {
      expect(existsSync(join(root, 'scripts', 'chef', `${match[1]}.ts`))).toBe(true);
    }
    for (const match of text.matchAll(/\.codex\/agents\/([\w-]+\.toml)/g)) {
      expect(existsSync(join(root, '.codex', 'agents', match[1]!))).toBe(true);
    }
  });

  test('stays within 500 words', () => {
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(500);
  });
});
