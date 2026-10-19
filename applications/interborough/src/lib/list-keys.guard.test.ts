/**
 * A keyed `{#each}` over server records without a unique id must key through `keyedByOccurrence`
 * (`list-keys.ts`): a key built from record fields collides when the server reports two records
 * alike, and Svelte then throws and takes the view down. This pins the lists that were moved, and
 * fails on any other keyed list whose key is built from several fields unless its uniqueness is
 * argued in `UNIQUE_COMPOSITE_KEYS`.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOT = join(import.meta.dir, '..');

/** Lists over server records with no id of their own, which must go through the helper. */
const OCCURRENCE_KEYED_LISTS: readonly string[] = [
  'app/fault-boundary.svelte',
  'routes/system/alerts-tab.svelte',
  'routes/workers/contract-failure-notice.svelte',
  'routes/workers/diagnostics-view.svelte',
  'routes/workers/manifest-diagnostics-view.svelte',
  'routes/workers/queue-detail-view.svelte',
  'routes/workers/task-delivery-history.svelte',
  'routes/workers/workflow-verification-detail.svelte',
];

/** Composite keys whose parts together are unique by construction, with why. */
const UNIQUE_COMPOSITE_KEYS: Readonly<Record<string, string>> = {
  'routes/system/dynamic-source-list.svelte': 'a source is registered once per (name, revision)',
  'routes/workers/manifest-diagnostics-view.svelte':
    'comparisons are one per (deploymentName, buildId); the rejection log goes through the helper',
  'routes/workers/worker-manifest-panel.svelte':
    'activity names are unique within a workflow, workflow names within a manifest',
  'routes/workflows/detail/worker-binding-panel.svelte':
    'the key includes the list position, so it cannot repeat',
};

function svelteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return svelteFiles(path);
    return entry.name.endsWith('.svelte') && !entry.name.includes('test-harness') ? [path] : [];
  });
}

/** Every `{#each ... (key)}` header in a file, as written. */
function eachHeaders(source: string): string[] {
  return source.match(/\{#each [^\n]*\([^\n]*\)\}/g) ?? [];
}

describe('keyed lists over server records without an id', () => {
  test.each(OCCURRENCE_KEYED_LISTS.map((file) => [file] as const))(
    '%s keys through keyedByOccurrence',
    (file) => {
      const source = readFileSync(join(SOURCE_ROOT, file), 'utf8');
      expect(source).toMatch(/keyedByOccurrence\(/);
      expect(source).toMatch(/import \{ keyedByOccurrence \} from '[./]+\/lib\/list-keys\.ts'/);
    },
  );

  test('no other keyed list builds its key from several record fields without saying why it is unique', () => {
    const offenders: string[] = [];
    for (const path of svelteFiles(SOURCE_ROOT)) {
      const file = relative(SOURCE_ROOT, path);
      if (file in UNIQUE_COMPOSITE_KEYS) continue;
      for (const header of eachHeaders(readFileSync(path, 'utf8'))) {
        if (/\(`[^`]*\$\{[^`]*\$\{[^`]*`\)\}$/.test(header)) offenders.push(`${file}: ${header}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
