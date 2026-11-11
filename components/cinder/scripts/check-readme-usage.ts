import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractUsageFence, matchesComponentTag } from './extract-readme-usage-example.ts';
import {
  COMPOSE_ONLY_LEAF_EXEMPTIONS,
  discoverReadmeComponents,
  DOTTED_NAMESPACE_ONLY_EXEMPTIONS,
  toIdentifier,
} from './readme-usage-contract.ts';

const COMPONENTS_ROOT = join(import.meta.dir, '..', 'src', 'components');

export type ReadmeUsageFailure = {
  componentId: string;
  reason: 'no-heading' | 'no-fence' | 'no-matching-tag';
  readmePath: string;
};

export function findReadmeUsageFailures(
  rootDirectory = COMPONENTS_ROOT,
): ReadonlyArray<ReadmeUsageFailure> {
  const failures: ReadmeUsageFailure[] = [];
  for (const { componentId, directory } of discoverReadmeComponents(rootDirectory)) {
    if (COMPOSE_ONLY_LEAF_EXEMPTIONS.has(componentId)) continue;
    const readmePath = join(directory, 'README.md');
    const extracted = extractUsageFence(readFileSync(readmePath, 'utf8'));
    if ('error' in extracted) {
      failures.push({ componentId, reason: extracted.error, readmePath });
      continue;
    }
    if (
      !DOTTED_NAMESPACE_ONLY_EXEMPTIONS.has(componentId) &&
      !matchesComponentTag(extracted.code, toIdentifier(componentId))
    ) {
      failures.push({ componentId, reason: 'no-matching-tag', readmePath });
    }
  }
  return failures;
}

const FAILURE_REASONS: Record<ReadmeUsageFailure['reason'], string> = {
  'no-heading': 'has no "## Usage" heading',
  'no-fence': 'has no Svelte code fence under "## Usage"',
  'no-matching-tag': 'has a usage example that never renders the component',
};

function main(): void {
  const failures = findReadmeUsageFailures();
  if (failures.length === 0) {
    process.stdout.write('check-readme-usage — OK (every component README has a usage example).\n');
    return;
  }

  process.stderr.write(
    `check-readme-usage — ${failures.length} component README(s) lack a usage example:\n`,
  );
  for (const failure of failures) {
    process.stderr.write(
      `  ${failure.componentId}: ${failure.readmePath} ${FAILURE_REASONS[failure.reason]}\n`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
