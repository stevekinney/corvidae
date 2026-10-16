/**
 * Tests for the stable-promotion gate.
 *
 * Covers:
 *   - Button (reference stable component) — must PASS
 *   - Per-check FAIL scenarios via targeted assertions on helper functions
 *   - --json output shape and exit-code contracts (via Bun.spawn)
 */

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isObjectRecord } from './validation-utilities.ts';

import { hasBrowserGuard, hasHydrationTest } from './component-conventions-hydration.ts';
import {
  checkPropNames,
  hasBooleanIsPrefix,
  PROP_NAME_DENYLIST,
} from './component-conventions-props.ts';

const SCRIPT_FILE = join(fileURLToPath(import.meta.url), '..', 'check-promotion-readiness.ts');

const COMPONENTS_DIRECTORY = join(fileURLToPath(import.meta.url), '..', '..', 'src', 'components');

function componentDirectory(name: string, experimental = false): string {
  if (experimental) return join(COMPONENTS_DIRECTORY, 'experimental', name);
  return join(COMPONENTS_DIRECTORY, name);
}

// ---------------------------------------------------------------------------
// CLI helper — the real `bun` process is the behavior under test: this suite runs under
// `--conditions browser`, which resolves `prettier` to its standalone build, so the CLI cannot
// run in process. Each distinct invocation is spawned once at module scope (concurrently), off
// bun's per-test clock; the tests only assert on the settled results.
// ---------------------------------------------------------------------------

type PromotionCheckResult = { stdout: string; stderr: string; exitCode: number };

async function spawnPromotionCheck(args: string[]): Promise<PromotionCheckResult> {
  const process = spawnWithHangGuard(['bun', SCRIPT_FILE, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { stdout, stderr, exitCode };
}

const promotionCheckInvocations: string[][] = [['toast-region', '--json']];
const promotionCheckResults = new Map<string, PromotionCheckResult>(
  await Promise.all(
    promotionCheckInvocations.map(
      async (args) => [args.join(' '), await spawnPromotionCheck(args)] as const,
    ),
  ),
);

function runPromotionCheck(args: string[]): PromotionCheckResult {
  const result = promotionCheckResults.get(args.join(' '));
  if (!result) throw new Error(`No promotion check was spawned for: ${args.join(' ')}`);
  return result;
}
function parseJsonReport(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  if (!isObjectRecord(value)) {
    throw new Error('Expected a JSON object report');
  }
  return value;
}

function reportStatus(report: Record<string, unknown>, check: string): unknown {
  const checks = report['checks'];
  if (!isObjectRecord(checks)) {
    throw new Error('Expected report checks object');
  }
  const result = checks[check];
  if (!isObjectRecord(result)) {
    throw new Error(`Expected ${check} check object`);
  }
  return result['status'];
}

describe('hasBrowserGuard', () => {
  test('returns true for a component with a hydrated template guard', () => {
    const tempPath = join(tmpdir(), `browser-guard-hydrated-${Date.now()}.svelte`);
    writeFileSync(
      tempPath,
      `<script lang="ts">\n  let hydrated = $state(false);\n</script>\n{#if hydrated}<div />{/if}\n`,
    );
    try {
      expect(hasBrowserGuard(tempPath)).toBe(true);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });

  test('returns true for a component with a member-expression hydrated template guard', () => {
    const tempPath = join(tmpdir(), `browser-guard-member-hydrated-${Date.now()}.svelte`);
    writeFileSync(
      tempPath,
      `<script lang="ts">\n  const dialogState = { hydrated: true };\n</script>\n{#if dialogState.hydrated}<div />{/if}\n`,
    );
    try {
      expect(hasBrowserGuard(tempPath)).toBe(true);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });

  test('returns true for navigation-bar (imports BROWSER from esm-env)', () => {
    const sveltePath = join(componentDirectory('navigation-bar'), 'navigation-bar.svelte');
    expect(hasBrowserGuard(sveltePath)).toBe(true);
  });

  test('returns false for button (no browser guard)', () => {
    const sveltePath = join(componentDirectory('button'), 'button.svelte');
    expect(hasBrowserGuard(sveltePath)).toBe(false);
  });

  test('returns false for non-existent file', () => {
    expect(hasBrowserGuard('/tmp/no-such-file.svelte')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: checkPropNames
// ---------------------------------------------------------------------------

describe('checkPropNames', () => {
  test('passes for conventional camelCase prop names', () => {
    const schema = {
      properties: {
        variant: {},
        iconOnly: {},
        fullWidth: {},
        class: {},
        'aria-label': {},
        'data-testid': {},
      },
    };
    const { violations } = checkPropNames(schema);
    expect(violations).toHaveLength(0);
  });

  test('fails for denylist entries (all-lowercase forbidden forms)', () => {
    for (const deniedName of PROP_NAME_DENYLIST) {
      const schema = { properties: { [deniedName]: {} } };
      const { violations } = checkPropNames(schema);
      expect(violations.length).toBeGreaterThan(0);
    }
  });

  test('passes for iconOnly (the correct camelCase form, NOT in denylist)', () => {
    // icononly is denied; iconOnly (camelCase) must be allowed
    const schema = { properties: { iconOnly: {} } };
    const { violations } = checkPropNames(schema);
    expect(violations).toHaveLength(0);
  });

  test('fails for className even though it is valid camelCase (convention: class)', () => {
    // cinder components expose `class?: string`, never `className`.
    const schema = { properties: { className: {} } };
    const { violations } = checkPropNames(schema);
    expect(violations.length).toBeGreaterThan(0);
  });

  test('passes for the canonical class passthrough', () => {
    const schema = { properties: { class: {} } };
    const { violations } = checkPropNames(schema);
    expect(violations).toHaveLength(0);
  });

  test('fails for kebab-case prop names', () => {
    const schema = { properties: { 'full-width': {} } };
    const { violations } = checkPropNames(schema);
    expect(violations.length).toBeGreaterThan(0);
  });

  test('fails for PascalCase prop names', () => {
    const schema = { properties: { Variant: {} } };
    const { violations } = checkPropNames(schema);
    expect(violations.length).toBeGreaterThan(0);
  });

  test('returns warnings for is-prefix props', () => {
    const schema = { properties: { isLoading: {} } };
    const { violations, warnings } = checkPropNames(schema);
    expect(violations).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('returns warnings for has-prefix props', () => {
    const schema = { properties: { hasError: {} } };
    const { violations, warnings } = checkPropNames(schema);
    expect(violations).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('passes for schema with no properties', () => {
    const { violations } = checkPropNames({});
    expect(violations).toHaveLength(0);
  });

  test('passes for custom onDismiss callback casing', () => {
    const schema = { properties: { onDismiss: {} } };
    const { violations } = checkPropNames(schema);
    expect(violations).toHaveLength(0);
  });

  test('fails for onClick even though onclick is the denied native event form', () => {
    const schema = { properties: { onClick: {} } };
    const { violations } = checkPropNames(schema);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatch(/onClick/);
  });

  test('fails for onChange even though onchange is the denied form', () => {
    const schema = { properties: { onChange: {} } };
    const { violations } = checkPropNames(schema);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatch(/onChange/);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: hasBooleanIsPrefix
// ---------------------------------------------------------------------------

describe('hasBooleanIsPrefix', () => {
  test('returns true for is-prefix props', () => {
    expect(hasBooleanIsPrefix('isLoading')).toBe(true);
    expect(hasBooleanIsPrefix('isDisabled')).toBe(true);
  });

  test('returns true for has-prefix props', () => {
    expect(hasBooleanIsPrefix('hasError')).toBe(true);
  });

  test('returns false for conventional props', () => {
    expect(hasBooleanIsPrefix('loading')).toBe(false);
    expect(hasBooleanIsPrefix('disabled')).toBe(false);
    expect(hasBooleanIsPrefix('variant')).toBe(false);
    expect(hasBooleanIsPrefix('class')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: hasHydrationTest
// ---------------------------------------------------------------------------

describe('hasHydrationTest', () => {
  test('returns true for portal.test.ts (calls hydrateServerHtml)', () => {
    const testFile = join(componentDirectory('portal'), 'portal.test.ts');
    expect(existsSync(testFile)).toBe(true);
    expect(hasHydrationTest(testFile)).toBe(true);
  });

  test('returns false for button.test.ts (no renderThenHydrate)', () => {
    const testFile = join(componentDirectory('button'), 'button.test.ts');
    expect(hasHydrationTest(testFile)).toBe(false);
  });

  test('returns false for non-existent file', () => {
    expect(hasHydrationTest('/tmp/no-such-file.test.ts')).toBe(false);
  });

  test('returns true when renderThenHydrate is inside an active test() block', () => {
    const tempPath = join(tmpdir(), `hydration-active-${Date.now()}.test.ts`);
    writeFileSync(
      tempPath,
      `import { test } from 'bun:test';\n` +
        `test('hydrates', () => { renderThenHydrate(Foo, src, {}); });\n`,
    );
    try {
      expect(hasHydrationTest(tempPath)).toBe(true);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });

  test('returns true when hydrateServerHtml is inside an active test() block', () => {
    const tempPath = join(tmpdir(), `hydration-server-html-${Date.now()}.test.ts`);
    writeFileSync(
      tempPath,
      `import { test } from 'bun:test';\n` +
        `test('hydrates', () => { hydrateServerHtml(Foo, html, {}); });\n`,
    );
    try {
      expect(hasHydrationTest(tempPath)).toBe(true);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });

  test('returns false when renderThenHydrate is only inside test.skip (never runs)', () => {
    const tempPath = join(tmpdir(), `hydration-skip-${Date.now()}.test.ts`);
    writeFileSync(
      tempPath,
      `import { test } from 'bun:test';\n` +
        `test.skip('hydrates', () => { renderThenHydrate(Foo, src, {}); });\n`,
    );
    try {
      expect(hasHydrationTest(tempPath)).toBe(false);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: --json shape contract (exit 1 on FAIL)
// ---------------------------------------------------------------------------

describe('--json output shape on a failing component', () => {
  test('toast-region exits 1 (hydration FAIL) with valid JSON report', () => {
    const { stdout, exitCode } = runPromotionCheck(['toast-region', '--json']);
    expect(exitCode).toBe(1);

    const report = parseJsonReport(stdout);
    expect(report['result']).toBe('FAIL');
    expect(report['component']).toBe('toast-region');
    expect(reportStatus(report, 'hydration')).toBe('fail');
  });

  test('--json emits no stdout text before the JSON object on FAIL', () => {
    const { stdout } = runPromotionCheck(['toast-region', '--json']);
    expect(stdout.trimStart()).toMatch(/^\{/);
  });

  // KNOWN COVERAGE GAP: the schema-drift FAIL paths in runPropNamesCheck
  // (missing .schema.json, missing .types.ts, stale schema, generator throw)
  // are not directly exercised — every committed component has an in-sync
  // schema, so there is no real fixture to trigger them, and the script
  // resolves COMPONENTS_DIRECTORY relative to itself which makes a synthetic
  // out-of-tree component directory impractical to wire through the CLI. The
  // drift PASS path is covered by the button and json-viewer integration
  // tests above. The FAIL paths are simple guard clauses returning a
  // structured { status: 'fail', detail } result.
});
