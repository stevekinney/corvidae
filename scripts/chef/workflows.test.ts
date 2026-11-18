import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const workflowsDirectory = join(root, '.claude', 'workflows');
const protocolPath = join(root, '.agents', 'skills', 'chef', 'references', 'codex-protocol.md');

const workflowFiles = readdirSync(workflowsDirectory).filter((name) => name.endsWith('.js'));

interface Preparation {
  accepted: boolean;
  briefPath: string;
  blockers: string[];
  gate: { status: string; dispatchable: boolean };
  error?: string;
}

async function runDelivery(prepared: Preparation, arguments_ = {}) {
  const source = readFileSync(join(workflowsDirectory, 'deliver-issue.js'), 'utf8').replace(
    /^export const meta = \{[\s\S]*?^};\n/m,
    '',
  );
  const calls: { prompt: string; options: { phase: string } }[] = [];
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...arguments_: string[]
  ) => (...arguments_: unknown[]) => Promise<unknown>;
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', source);
  const result = (await run(
    { issues: ['COR-7'], ...arguments_ },
    async (prompt: string, options: { phase: string }) => {
      calls.push({ prompt, options });
      if (options.phase === 'prepare') return prepared;
      if (options.phase === 'implement')
        return {
          status: 'ready-for-review',
          pr: '17',
          head: 'abc',
          worktree: '/worktree',
          report: '',
        };
      return { verdict: 'approve', findings: [] };
    },
    () => undefined,
    () => undefined,
    async (tasks: (() => Promise<unknown>)[]) => Promise.all(tasks.map((task) => task())),
  )) as { status: string; reason?: string }[];
  return { calls, result };
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
      // review (`chef-reviewer`), or an implementation, which must run as `chef-worker`: a
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
          if (agentType === 'chef-reviewer') continue;
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

  // A chef-worker opens no pull request unless its dispatch asks for one, and deliver-issue.js
  // reviews the pull request its implement dispatch returns, so that dispatch must ask for one.
  test('deliver-issue.js asks its implement dispatch for a pull request', () => {
    const source = readFileSync(join(workflowsDirectory, 'deliver-issue.js'), 'utf8');
    const call = source.slice(source.indexOf('const built = await agent('));
    const prompt = call.slice(0, call.indexOf('label:'));
    expect(prompt).toContain('asks for a pull request');
  });

  test('deliver-issue.js passes only coordinator-supplied context and classification to brief preparation', () => {
    const source = readFileSync(join(workflowsDirectory, 'deliver-issue.js'), 'utf8');
    expect(source).toContain('args.verifiedContexts');
    expect(source).toContain('args.classifications');
    expect(source).toContain("arguments_.push('--context', shellArgument(context))");
    expect(source).toContain("arguments_.push('--classification', shellArgument(classification))");
  });

  test('deliver-issue.js never dispatches a worker for canonical preparation refusals', async () => {
    for (const prepared of [
      {
        accepted: false,
        briefPath: '',
        blockers: [],
        gate: { status: 'invalid', dispatchable: false },
        error: 'repository pin does not match origin',
      },
      {
        accepted: false,
        briefPath: '',
        blockers: [],
        gate: { status: 'blocked', dispatchable: false },
        error: 'required context is unreadable',
      },
      {
        accepted: true,
        briefPath: '',
        blockers: [],
        gate: { status: 'accepted', dispatchable: true },
      },
    ]) {
      const delivery = await runDelivery(prepared);
      expect(delivery.calls.filter((call) => call.options.phase === 'implement')).toHaveLength(0);
      expect(delivery.result[0]?.status).toBe('blocked');
    }
  });

  test('deliver-issue.js keeps verified context and classification as one shell argument each', async () => {
    const delivery = await runDelivery(
      {
        accepted: true,
        briefPath: 'tmp/chef/briefs/COR-7.md',
        blockers: [],
        gate: { status: 'accepted', dispatchable: true },
      },
      {
        verifiedContexts: { 'COR-7': "/coordinator/boards/with space/'quoted'; touch nope" },
        classifications: { 'COR-7': 'no-behavior' },
      },
    );
    const prompt = delivery.calls[0]?.prompt ?? '';
    expect(prompt).toContain('--base "$(git rev-parse HEAD)"');
    expect(prompt).not.toContain('<that-40-character-sha>');
    expect(prompt).toContain(
      "--context '/coordinator/boards/with space/'\"'\"'quoted'\"'\"'; touch nope'",
    );
    expect(prompt).toContain("--classification 'no-behavior'");
    expect(delivery.calls.filter((call) => call.options.phase === 'implement')).toHaveLength(1);
  });

  test('deliver-issue.js refuses an invalid coordinator classification before preparation', async () => {
    const delivery = await runDelivery(
      {
        accepted: true,
        briefPath: 'tmp/chef/briefs/COR-7.md',
        blockers: [],
        gate: { status: 'accepted', dispatchable: true },
      },
      { classifications: { 'COR-7': 'no-behavior; touch nope' } },
    );
    expect(delivery.calls).toHaveLength(0);
    expect(delivery.result[0]?.reason).toBe('invalid coordinator classification');
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
