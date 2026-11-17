import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cinderComponentRoots } from './discover-component-directories.ts';
import { extractUsageFence, matchesComponentTag } from './extract-readme-usage-example.ts';
import {
  COMPOSE_ONLY_LEAF_EXEMPTIONS,
  discoverReadmeComponents,
  DOTTED_NAMESPACE_ONLY_EXEMPTIONS,
  toIdentifier,
} from './readme-usage-contract.ts';

export type ReadmeUsageFailure = {
  componentId: string;
  reason: 'no-heading' | 'no-fence' | 'no-matching-tag';
  readmePath: string;
};

/** Every README'd component core lists, in core's components root or in one of its packages'. */
export function readmeComponents(roots: string | readonly string[] = cinderComponentRoots()) {
  return (typeof roots === 'string' ? [roots] : roots).flatMap((root) =>
    discoverReadmeComponents(root),
  );
}

export function findReadmeUsageFailures(
  rootDirectory: string | readonly string[] = cinderComponentRoots(),
): ReadonlyArray<ReadmeUsageFailure> {
  const failures: ReadmeUsageFailure[] = [];
  for (const { componentId, directory } of readmeComponents(rootDirectory)) {
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
