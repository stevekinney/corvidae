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

import {
  hasA11yCoverage,
  hasA11yDoc,
  hasSubstantiveTest,
  isInteractive,
} from './component-conventions-tests.ts';

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

const promotionCheckInvocations: string[][] = [
  ['button'],
  ['button', '--json'],
  ['not-a-real-component-xyzzy'],
  [],
  ['not-a-real-component-xyzzy', '--json'],
  ['json-viewer'],
  ['json-viewer', '--json'],
];
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

// ---------------------------------------------------------------------------
// Reference component: button must PASS (exit 0)
// ---------------------------------------------------------------------------

describe('button reference component', () => {
  test('exits 0 for button', () => {
    const { exitCode } = runPromotionCheck(['button']);
    expect(exitCode).toBe(0);
  });

  test('--json output for button is PASS with correct shape', () => {
    const { stdout, exitCode } = runPromotionCheck(['button', '--json']);
    expect(exitCode).toBe(0);
    const report = parseJsonReport(stdout);
    expect(report['component']).toBe('button');
    expect(report['result']).toBe('PASS');
    expect(reportStatus(report, 'test')).toBe('pass');
    expect(reportStatus(report, 'a11y')).toBe('pass');
    expect(reportStatus(report, 'hydration')).toBe('na');
    expect(reportStatus(report, 'propNames')).toBe('pass');
    expect(Array.isArray(report['warnings'])).toBe(true);
  });

  test('--json emits no text before the JSON object', () => {
    const { stdout } = runPromotionCheck(['button', '--json']);
    // stdout must start with the JSON object, no leading prose/diagnostics
    expect(stdout.trimStart()).toMatch(/^\{/);
  });
});

// ---------------------------------------------------------------------------
// Error handling — unknown component exits 1
// ---------------------------------------------------------------------------

test('exits 1 for unknown component', () => {
  const { exitCode, stderr } = runPromotionCheck(['not-a-real-component-xyzzy']);
  expect(exitCode).toBe(1);
  expect(stderr).toMatch(/not found/i);
});

test('exits 1 with no arguments', () => {
  const { exitCode } = runPromotionCheck([]);
  expect(exitCode).toBe(1);
});

test('--json exits 1 for unknown component with no stdout (error on stderr only)', () => {
  const { stdout, stderr, exitCode } = runPromotionCheck(['not-a-real-component-xyzzy', '--json']);
  expect(exitCode).toBe(1);
  expect(stdout.trim()).toBe('');
  expect(stderr).toMatch(/not found/i);
});

// ---------------------------------------------------------------------------
// Experimental component path
// ---------------------------------------------------------------------------

describe('experimental component (json-viewer)', () => {
  test('exits 0 for json-viewer (experimental, alpha)', () => {
    const { exitCode } = runPromotionCheck(['json-viewer']);
    expect(exitCode).toBe(0);
  });

  test('--json for json-viewer reports propNames pass (depthToSrc=3 path)', () => {
    const { stdout, exitCode } = runPromotionCheck(['json-viewer', '--json']);
    expect(exitCode).toBe(0);
    const report = parseJsonReport(stdout);
    expect(report['component']).toBe('json-viewer');
    expect(reportStatus(report, 'propNames')).toBe('pass');
    expect(report['result']).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: hasSubstantiveTest
// ---------------------------------------------------------------------------

describe('hasSubstantiveTest', () => {
  test('returns { pass: true } for button.test.ts (has active tests)', () => {
    const testFile = join(componentDirectory('button'), 'button.test.ts');
    expect(existsSync(testFile)).toBe(true);
    const { pass, count } = hasSubstantiveTest(testFile);
    expect(pass).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('returns { pass: false, count: 0 } for a non-existent file', () => {
    const result = hasSubstantiveTest('/tmp/does-not-exist-xyzzy.test.ts');
    expect(result.pass).toBe(false);
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: isInteractive
// ---------------------------------------------------------------------------

describe('isInteractive', () => {
  test('returns true for action category', () => {
    expect(isInteractive({ category: 'action' })).toBe(true);
  });

  test('returns true for form category', () => {
    expect(isInteractive({ category: 'form' })).toBe(true);
  });

  test('returns true for navigation category', () => {
    expect(isInteractive({ category: 'navigation' })).toBe(true);
  });

  test('returns true for overlay category', () => {
    expect(isInteractive({ category: 'overlay' })).toBe(true);
  });

  test('returns false for feedback category', () => {
    expect(isInteractive({ category: 'feedback' })).toBe(false);
  });

  test('returns false for layout category', () => {
    expect(isInteractive({ category: 'layout' })).toBe(false);
  });

  test('returns false for data-display category', () => {
    expect(isInteractive({ category: 'data-display' })).toBe(false);
  });

  test('returns false for undefined category', () => {
    expect(isInteractive({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: hasA11yDoc
// ---------------------------------------------------------------------------

describe('hasA11yDoc', () => {
  test('returns true for button (has adjacent a11y doc)', () => {
    const dir = componentDirectory('button');
    expect(hasA11yDoc(dir, 'button')).toBe(true);
  });

  test('returns false for a component without an a11y doc', () => {
    // table-cell is a compose-only leaf whose accessibility contract lives on Table.
    const dir = componentDirectory('table-cell');
    expect(hasA11yDoc(dir, 'table-cell')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: hasA11yCoverage
// ---------------------------------------------------------------------------

describe('hasA11yCoverage', () => {
  test('returns false for non-existent file', () => {
    expect(hasA11yCoverage('/tmp/no-such-a11y.test.ts')).toBe(false);
  });

  test('returns true when a single test block has both a keyboard call and a role query', () => {
    const tempPath = join(tmpdir(), `a11y-coverage-pass-${Date.now()}.test.ts`);
    writeFileSync(
      tempPath,
      `
import { fireEvent } from '@testing-library/svelte';
test('keyboard and role', async () => {
  const { getByRole } = render(Component);
  const el = getByRole('button');
  await fireEvent.keyDown(el, { key: 'Enter' });
  expect(el).toBeTruthy();
});
`,
    );
    try {
      expect(hasA11yCoverage(tempPath)).toBe(true);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });

  test('returns false when keyboard call and role query are in separate test blocks', () => {
    const tempPath = join(tmpdir(), `a11y-coverage-split-${Date.now()}.test.ts`);
    writeFileSync(
      tempPath,
      `
import { fireEvent } from '@testing-library/svelte';
test('keyboard only', async () => {
  await fireEvent.keyDown(document.body, { key: 'Enter' });
});
test('role only', () => {
  const el = getByRole('button');
  expect(el).toBeTruthy();
});
`,
    );
    try {
      expect(hasA11yCoverage(tempPath)).toBe(false);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });

  test('returns false when only keyboard call is present (no role query)', () => {
    const tempPath = join(tmpdir(), `a11y-coverage-noRole-${Date.now()}.test.ts`);
    writeFileSync(
      tempPath,
      `
import { fireEvent } from '@testing-library/svelte';
test('keyboard only', async () => {
  await fireEvent.keyDown(document.body, { key: 'Enter' });
  expect(true).toBe(true);
});
`,
    );
    try {
      expect(hasA11yCoverage(tempPath)).toBe(false);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });

  test('returns false when only role query is present (no keyboard call)', () => {
    const tempPath = join(tmpdir(), `a11y-coverage-noKeyboard-${Date.now()}.test.ts`);
    writeFileSync(
      tempPath,
      `
test('role only', () => {
  const el = getByRole('button');
  expect(el).toBeTruthy();
});
`,
    );
    try {
      expect(hasA11yCoverage(tempPath)).toBe(false);
    } finally {
      rmSync(tempPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: hasBrowserGuard
// ---------------------------------------------------------------------------
