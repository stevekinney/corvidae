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
