import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { mirrorTargets } from './target-definitions.ts';

/**
 * Pinning tests for `.github/workflows/mirror-sync.yaml`, the one workflow file AGENTS.md's
 * publishing/CI prohibition exempts.
 *
 * This workflow is hand-written rather than rendered — unlike `mirror-verify.yaml`
 * (`mirror-verify-workflow.ts`), nothing about its shape depends on a target's staged plan, so
 * there is no generator to test through. What these tests pin instead is exactly what COR-1195
 * requires and what a careless edit could quietly break: no second workflow file, no `push`
 * trigger, no `GITHUB_TOKEN` anywhere in `.github/workflows`, the Bun version matching corvidae's
 * own `packageManager` pin, the dispatch's target choices matching `mirrorTargets`, and
 * `MIRROR_APP_PRIVATE_KEY` as the only secret referenced.
 */

const workflowsDirectory = join(import.meta.dir, '..', '..', '.github', 'workflows');
const workflowPath = join(workflowsDirectory, 'mirror-sync.yaml');

async function readWorkflow(): Promise<string> {
  return Bun.file(workflowPath).text();
}

describe('.github/workflows', () => {
  test('carries exactly the one workflow AGENTS.md exempts, nothing else', async () => {
    const entries = await readdir(workflowsDirectory);
    expect(entries).toEqual(['mirror-sync.yaml']);
  });

  test('never mentions GITHUB_TOKEN, in this file or any other under .github/workflows', async () => {
    const entries = await readdir(workflowsDirectory);
    for (const entry of entries) {
      const text = await Bun.file(join(workflowsDirectory, entry)).text();
      expect(text).not.toContain('GITHUB_TOKEN');
    }
  });
});

describe('mirror-sync.yaml', () => {
  test('triggers on workflow_dispatch and schedule only, never push', async () => {
    const text = await readWorkflow();
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
    expect(text).toMatch(/^\s*schedule:/m);
    expect(text).not.toMatch(/^\s*push:/m);
  });

  test("the dispatch target choices are exactly manifests.ts's mirrorTargets, in order", async () => {
    const text = await readWorkflow();
    const optionsBlock = text.match(/options:\n((?:\s+- .+\n)+)/);
    expect(optionsBlock).not.toBeNull();
    const options = (optionsBlock?.[1] ?? '')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().replace(/^-\s*/, ''));
    expect(options).toEqual([...mirrorTargets]);
  });

  test('pins the same Bun version as the root packageManager field', async () => {
    const [text, packageJsonText] = await Promise.all([
      readWorkflow(),
      Bun.file(join(import.meta.dir, '..', '..', 'package.json')).text(),
    ]);
    const packageJson = JSON.parse(packageJsonText) as { packageManager?: string };
    const pinnedVersion = packageJson.packageManager?.split('@').at(1);
    expect(pinnedVersion).toBeTruthy();
    const bunVersionLines = [...text.matchAll(/bun-version:\s*(\S+)/g)].map((match) => match[1]);
    expect(bunVersionLines.length).toBeGreaterThan(0);
    for (const version of bunVersionLines) {
      expect(version).toBe(pinnedVersion);
    }
  });

  test('references exactly one secret, MIRROR_APP_PRIVATE_KEY', async () => {
    const text = await readWorkflow();
    const secretReferences = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
    expect(secretReferences).toEqual(['MIRROR_APP_PRIVATE_KEY']);
  });

  test('the drift-report job never dispatches with a target absent from mirrorTargets', async () => {
    const text = await readWorkflow();
    const matrixBlock = text.match(/matrix:\n\s+target: \[([^\]]+)\]/);
    expect(matrixBlock).not.toBeNull();
    const matrixTargets = (matrixBlock?.[1] ?? '').split(',').map((entry) => entry.trim());
    expect(matrixTargets).toEqual([...mirrorTargets]);
  });

  test('reads the App key without ever writing it to a file', async () => {
    const text = await readWorkflow();
    expect(text).toContain('MIRROR_APP_PRIVATE_KEY: ${{ secrets.MIRROR_APP_PRIVATE_KEY }}');
    expect(text).not.toContain('MIRROR_APP_PRIVATE_KEY_FILE');
    expect(text).not.toMatch(/>\s*.*private[-_]key/i);
  });
});
