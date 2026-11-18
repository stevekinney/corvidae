import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function workflow(name: string): string {
  return readFileSync(resolve(import.meta.dir, '..', '.github/workflows', name), 'utf8');
}

/** The top-level `concurrency:` block of a workflow, two-space indented lines after its key. */
function concurrencyBlock(text: string): string {
  const match = /^concurrency:\n((?: {2}.*\n)+)/mu.exec(text);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

// A newer dispatch on a branch cancels the older one; a push to `main` keeps its one group, which
// never cancels a running run.
describe('workflow_dispatch concurrency', () => {
  test('main.yml cancels an older dispatch on the same ref and never a push to main', () => {
    const block = concurrencyBlock(workflow('main.yml'));
    expect(block).toContain("format('main-dispatch-{0}', github.ref) || 'main'");
    expect(block).toContain("cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' }}");
    expect(block).not.toContain('cancel-in-progress: true');
  });

  test('targeted-checks.yml takes a group per ref and cancels an older dispatch', () => {
    const block = concurrencyBlock(workflow('targeted-checks.yml'));
    expect(block).toContain('group: targeted-checks-${{ github.ref }}');
    expect(block).toContain("cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' }}");
  });

  // Two faults reached main because a targeted run did no type-check.
  test('targeted-checks.yml lints and type-checks the workspaces changed against main', () => {
    const text = workflow('targeted-checks.yml');
    const start = text.indexOf('\n  checks:\n');
    expect(start).toBeGreaterThan(-1);
    const job = text.slice(start, text.indexOf('\n  fixtures:\n'));
    expect(job).toContain('TURBO_SCM_BASE: origin/main');
    expect(job).toContain('fetch-depth: 0');
    expect(job).toContain('turbo run lint typecheck --affected');
    expect(job).not.toContain('if:');
  });

  // A dispatch without unit_config ran Interborough UI tests DOM-less (run 44371426895).
  test('an Interborough unit run outside src/host defaults to bunfig.ui.toml', () => {
    const text = workflow('targeted-checks.yml');
    const job = text.slice(text.indexOf('\n  unit:\n'));
    expect(job).toContain('[ "$UNIT_WORKSPACE" = applications/interborough ]');
    expect(job).toContain('src/host|src/host/*|fixtures|fixtures/*) host=1');
    expect(job).toContain('UNIT_CONFIG=./bunfig.ui.toml');
  });
});
