/**
 * The guard on a fresh checkout: a package suite whose spec reads its ignored fixture manifest at
 * module scope, with no manifest on disk. The guard must run the suite's prepare step before it
 * lists the configuration, as `lint:root` does on a checkout that has never served the fixtures.
 *
 * The layouts are built under the repository's ignored `tmp/`, so their specs and configurations
 * resolve `@playwright/test` from the workspace's `node_modules`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';

const repositoryRoot = join(import.meta.dir, '..');
const roots: string[] = [];

function layout(files: Record<string, string>): string {
  const parent = join(repositoryRoot, 'tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'playwright-collection-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const browser = 'components/demo/browser';
const manifest = `${browser}/.playwright/manifest.json`;

const files = {
  [`${browser}/playwright.config.ts`]: `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: '**/*.playwright.ts' });
`,
  [`${browser}/harness.ts`]: `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (Bun.argv[2] === 'prepare') {
  mkdirSync(join(import.meta.dirname, '.playwright'), { recursive: true });
  writeFileSync(join(import.meta.dirname, '.playwright/manifest.json'), '{"entries":["one"]}');
}
`,
  [`${browser}/tests/demo.playwright.ts`]: `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
const { entries } = JSON.parse(
  readFileSync(join(import.meta.dirname, '../.playwright/manifest.json'), 'utf8'),
) as { entries: string[] };
for (const entry of entries) test(entry, () => {});
`,
};

async function guard(root: string): Promise<{ exitCode: number; output: string }> {
  const child = spawnWithHangGuard(
    [process.execPath, join(import.meta.dir, 'check-playwright-collection.ts'), '--root', root],
    { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe', env: process.env },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

// The guard's runs are the behavior under test, so they run once at module scope, off Bun's
// per-test clock; the tests below assert on the settled results.
const fresh = layout(files);
const manifestBefore = existsSync(join(fresh, manifest));
const freshRun = await guard(fresh);
const manifestAfter = existsSync(join(fresh, manifest));

const stale = layout({
  ...files,
  [`${browser}/tests/stale.playwright.ts`]: `import { test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';
test('stale', () => { void fixtureRoute; });
`,
});
const staleRun = await guard(stale);

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-playwright-collection', () => {
  test('prepares a package suite whose manifest is missing, then lists it', () => {
    expect(manifestBefore).toBe(false);
    expect(freshRun.output).toContain(`${browser}/playwright.config.ts: Total: 1 test in 1 file`);
    expect(freshRun.exitCode).toBe(0);
    expect(manifestAfter).toBe(true);
  });

  test('fails a spec that imports a module that is not there', () => {
    expect(staleRun.output).toContain('does not load every spec');
    expect(staleRun.output).toContain('./overlay-fixture.ts');
    expect(staleRun.exitCode).toBe(1);
  });
});
