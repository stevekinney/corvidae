import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { rawDispatches, scanForRawDispatch } from './check-workflow-dispatch';

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'workflow-dispatch-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('main.yml dispatch guard', () => {
  test('flags a raw dispatch, in a command line or as an argument list', () => {
    expect(rawDispatches('run `gh workflow run main.yml --ref <branch>`')).toEqual([1]);
    expect(rawDispatches("x\n['gh', 'workflow', 'run', 'main.yml', '--ref', ref]")).toEqual([2]);
  });

  test('flags a raw targeted-checks.yml dispatch, which drops lanes', () => {
    expect(rawDispatches('gh workflow run targeted-checks.yml --ref b')).toEqual([1]);
    expect(rawDispatches("['gh', 'workflow', 'run', 'targeted-checks.yml']")).toEqual([1]);
    const root = fixture({
      '.codex/agents/worker.toml': 'Run gh workflow run targeted-checks.yml --ref b\n',
    });
    expect(scanForRawDispatch(root)).toEqual([{ file: '.codex/agents/worker.toml', line: 1 }]);
  });

  test('allows a line that says not to, and other workflows', () => {
    expect(rawDispatches('Never run `gh workflow run main.yml` by hand.')).toEqual([]);
    expect(rawDispatches('gh workflow run design-review-capture.yml --ref b')).toEqual([]);
  });

  test('fails on an agent-definition fixture holding the raw dispatch', () => {
    const root = fixture({
      '.claude/agents/worker.md': 'After the push run `gh workflow run main.yml --ref <branch>`.\n',
      '.codex/agents/worker.toml': 'Push, then gh workflow run main.yml --ref b\n',
      '.claude/workflows/deliver.js': "run(['gh', 'workflow', 'run', 'main.yml'])\n",
      'scripts/chef/helper.ts': "const c = 'gh workflow run main.yml';\n",
    });
    expect(scanForRawDispatch(root).toSorted((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: '.claude/agents/worker.md', line: 1 },
      { file: '.claude/workflows/deliver.js', line: 1 },
      { file: '.codex/agents/worker.toml', line: 1 },
      { file: 'scripts/chef/helper.ts', line: 1 },
    ]);
  });

  test('passes an agent definition that names targeted-run.ts, and the dispatcher itself', () => {
    const root = fixture({
      '.claude/agents/worker.md': 'Run `bun scripts/chef/targeted-run.ts`.\n',
      'scripts/chef/targeted-run.ts':
        "return ['gh', 'workflow', 'run', 'main.yml', '--ref', ref];\n",
    });
    expect(scanForRawDispatch(root)).toEqual([]);
  });
});
