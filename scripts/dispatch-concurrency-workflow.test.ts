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

  // `server.test.ts` reads the generated manifest, and the root `test:browser-fixtures` verifies the
  // curated build after the tests: the targeted lane for that workspace does both.
  test('targeted-checks.yml runs the browser-fixtures lane as test:browser-fixtures does', () => {
    const text = workflow('targeted-checks.yml');
    const start = text.indexOf('"$UNIT_WORKSPACE" = scripts/browser-fixtures');
    expect(start).toBeGreaterThan(-1);
    const lane = text.slice(start, text.indexOf('exit', start));
    const prepare = lane.indexOf('scripts/browser-fixtures/scripts/prepare-manifest.ts');
    const tests = lane.indexOf('bun test');
    const verify = lane.indexOf('scripts/browser-fixtures/scripts/verify-curated-build.ts');
    expect(prepare).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(prepare);
    expect(verify).toBeGreaterThan(tests);
    const rootScript = readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf8');
    expect(rootScript).toContain('verify-curated-build.ts');
  });

  test('targeted Playground unit files run in isolated Bun scopes', () => {
    const text = workflow('targeted-checks.yml');
    const job = text.slice(text.indexOf('\n  unit:\n'));
    const start = job.indexOf('if [ "$UNIT_WORKSPACE" = applications/playground ]; then');
    expect(start).toBeGreaterThan(-1);
    const end = job.indexOf('\n          fi', start);
    expect(end).toBeGreaterThan(start);
    const lane = job.slice(start, end);
    expect(lane).toContain('read -r -a playground_conditions <<< "$conditions"');
    expect(lane).toContain('read -r -a playground_paths <<< "$UNIT_PATHS"');
    expect(lane).toContain('playground_options+=("$config")');
    expect(lane).toContain(
      'bun test --isolate "${playground_options[@]}" "${playground_conditions[@]}" "${playground_paths[@]}"',
    );
    expect(job.slice(end)).toContain('bun test $config $conditions $UNIT_PATHS');
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
    // The job itself always runs; a step may carry a condition (the cache save runs unless cancelled).
    expect(job.slice(0, job.indexOf('\n    steps:\n'))).not.toContain('if:');
  });

  // A dispatch without unit_config ran Interborough UI tests DOM-less (run 44371426895).
  test('an Interborough unit run outside src/host defaults to bunfig.ui.toml', () => {
    const text = workflow('targeted-checks.yml');
    const job = text.slice(text.indexOf('\n  unit:\n'));
    expect(job).toContain('[ "$UNIT_WORKSPACE" = applications/interborough ]');
    expect(job).toContain('src/host|src/host/*|fixtures|fixtures/*) host=1');
    expect(job).toContain('UNIT_CONFIG=./bunfig.ui.toml');
  });

  // COR-2643: run 45023128727's host lane passed `--conditions browser`, under which Prettier
  // resolves to its standalone build and `bureau-client-generation.test.ts` could not load.
  test('an Interborough host lane runs with no export conditions, as its test script does', () => {
    const text = workflow('targeted-checks.yml');
    const job = text.slice(text.indexOf('\n  unit:\n'));
    const hostLane =
      'if [ -z "$UNIT_CONFIG" ] && [ "$UNIT_WORKSPACE" = applications/interborough ]; then\n            conditions=""';
    expect(job).toContain('conditions="--conditions browser --conditions svelte"');
    expect(job).toContain(hostLane);
    expect(job).toContain('bun test $config $conditions $UNIT_PATHS');
    // The host lane's conditions are decided after the config default, which leaves UNIT_CONFIG
    // empty only for a host path.
    expect(job.indexOf(hostLane)).toBeGreaterThan(job.indexOf('UNIT_CONFIG=./bunfig.ui.toml'));
  });
});
