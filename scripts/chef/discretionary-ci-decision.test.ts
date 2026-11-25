import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TargetedDependencies } from './targeted-inputs.ts';
import { run } from './targeted-run.ts';

test('COR-2605 requires a coordinator decision for standalone CI on the reviewed revision', () => {
  const candidate = 'a20b030142f0c55499bb57784de2378c5143838e';
  const ref = 'steve/cor-2605-catalog-mcp';
  const changed = [
    'bun.lock',
    'documentation/criteria-ledger/COR-2605.json',
    'packages/backchannel-mcp/package.json',
    'packages/backchannel-mcp/src/operation-tools.test.ts',
    'packages/backchannel-mcp/src/operation-tools.ts',
    'packages/backchannel/src/handler/operation-handler-mounts.ts',
    'packages/backchannel/src/handler/operation-handler.ts',
    'packages/backchannel/src/operation-catalog-authorization.test.ts',
    'packages/backchannel/src/operation-catalog/operation-dispatch.ts',
  ];
  const calls: string[][] = [];
  let head = candidate;
  let remote = candidate;
  let paths = changed;
  const dependencies: TargetedDependencies = {
    runner: (args) => {
      calls.push(args);
      const stdout =
        args[1] === 'diff'
          ? paths.join('\n')
          : args[1] === 'rev-parse'
            ? head
            : args[1] === 'ls-remote'
              ? `${remote}\trefs/heads/${ref}`
              : '';
      return { code: 0, stdout, stderr: '' };
    },
    exists: () => true,
    knownSlugs: () => new Set(),
    context: (knownSlugs) => ({
      knownSlugs,
      paths: new Set(changed),
      read: () => undefined,
      selectUnitTests: () => [],
    }),
  };
  const directory = mkdtempSync(join(tmpdir(), 'chef-discretionary-'));
  try {
    const decision = join(directory, 'decision.json');
    const flags = ['--ref', ref];
    const request = [...flags, '--decision', decision];
    const dispatched = () => calls.filter((command) => command[0] === 'gh');
    expect(() => run(flags, dependencies)).toThrow('coordinator decision');
    expect(() => run(request, dependencies)).toThrow('decision');
    expect(dispatched()).toEqual([]);

    run(
      [
        ...flags,
        '--approve',
        decision,
        '--head',
        candidate,
        '--review-ref',
        'COR-2605 local receipt',
      ],
      dependencies,
    );
    expect(dispatched()).toEqual([]);
    remote = 'b'.repeat(40);
    expect(() => run(request, dependencies)).toThrow('remote');
    expect(dispatched()).toEqual([]);

    remote = candidate;
    head = 'c'.repeat(40);
    expect(() => run(request, dependencies)).toThrow('different branch, revision or dispatch plan');
    head = candidate;
    paths = ['packages/bureau/src/http/__fixtures__/wire-golden/local.openrpc.json'];
    expect(() => run(request, dependencies)).toThrow('different branch, revision or dispatch plan');
    paths = changed;
    expect(dispatched()).toEqual([]);
    run(request, dependencies);
    expect(() => run(request, dependencies)).toThrow('existing attempt');
    const plan = JSON.parse(run([...flags, '--dry-run', '--json'], dependencies).output);
    expect(dispatched()).toEqual([[...plan.command, '-f', `chef_candidate=${candidate}`]]);

    paths = ['packages/bureau/src/http/__fixtures__/wire-golden/local.openrpc.json'];
    const fullDecision = join(directory, 'full-decision.json');
    run(
      [
        ...flags,
        '--approve',
        fullDecision,
        '--head',
        candidate,
        '--review-ref',
        'local full plan review',
      ],
      dependencies,
    );
    run([...flags, '--decision', fullDecision], dependencies);
    expect(dispatched().at(-1)).toEqual([
      'gh',
      'workflow',
      'run',
      'main.yml',
      '--ref',
      ref,
      '-f',
      `chef_candidate=${candidate}`,
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

for (const workflow of ['main', 'targeted-checks']) {
  test(`${workflow} refuses a moved revision before starting the evidence jobs`, async () => {
    const source = await Bun.file(
      `${import.meta.dir}/../../.github/workflows/${workflow}.yml`,
    ).text();
    const parsed = Bun.YAML.parse(source) as {
      concurrency: { group: string };
      jobs: Record<string, { if: string }>;
    };
    expect(parsed.concurrency.group).toContain("'-stale-candidate'");
    const { 'stale-candidate': rejected, ...evidence } = parsed.jobs;
    expect(rejected?.if).toContain(
      "inputs.chef_candidate != '' && inputs.chef_candidate != github.sha",
    );
    expect(Object.keys(evidence).length).toBeGreaterThan(0);
    for (const [name, job] of Object.entries(evidence)) {
      expect(job.if, name).toContain(
        "inputs.chef_candidate == '' || inputs.chef_candidate == github.sha",
      );
    }
  });
}
