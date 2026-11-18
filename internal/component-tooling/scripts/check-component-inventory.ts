/**
 * Enforces a written neighbour rationale for every canonical component.
 *
 * This guard validates authored metadata only (`<name>.meta.json`). It deliberately does not try
 * to infer whether two components should be consolidated.
 */

import {
  discoverComponentDirectories,
  type DiscoveredComponent,
} from './discover-component-directories.ts';
import { readComponentMeta, type AvoidWhenEntry } from './lib/component-meta.ts';

export type InventoryEntry = {
  id: string;
  related: readonly string[];
  avoidWhen: readonly AvoidWhenEntry[];
  /** The `rationale` field of `<name>.meta.json`, when one is authored. */
  rationale?: string;
};

export type InventoryViolation = {
  id: string;
  reason: string;
};

function toComponentId(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function findNamedAlternative(rationale: string): string | null {
  const patterns = [
    /\b(?:nearest|closest)\s+alternative\s*:\s*[*_`]*([a-z][a-z0-9-]*)\b/i,
    /\b(?:nearest|closest)\s+alternative\s+(?:is|would be)\s+[*_`]*([a-z][a-z0-9-]*)\b/i,
    /\|\s*[*_`]*([a-z][a-z0-9-]*)\b/i,
  ];
  for (const pattern of patterns) {
    const alternative = rationale.match(pattern)?.[1];
    if (alternative) return toComponentId(alternative);
  }
  return null;
}

const AVOID_WHEN_PLACEHOLDER = /^todo\b/i;

function hasAuthoredAvoidWhen(avoidWhen: readonly AvoidWhenEntry[]): boolean {
  return avoidWhen.some((item) => !AVOID_WHEN_PLACEHOLDER.test(item.reason.trim()));
}

export function findNeighbourRationaleViolations(
  entry: InventoryEntry,
  knownComponentIds: ReadonlySet<string>,
): InventoryViolation[] {
  const hasKnownRelated = entry.related.some(
    (relatedId) => relatedId !== entry.id && knownComponentIds.has(relatedId),
  );
  const hasRelatedAndAvoidWhen = hasKnownRelated && hasAuthoredAvoidWhen(entry.avoidWhen);
  const namedAlternative = findNamedAlternative(entry.rationale ?? '');
  const hasExplicitRationale =
    namedAlternative !== null &&
    namedAlternative !== entry.id &&
    knownComponentIds.has(namedAlternative);

  if (hasRelatedAndAvoidWhen || hasExplicitRationale) return [];
  return [
    {
      id: entry.id,
      reason:
        'component metadata must provide related and avoidWhen, or a rationale naming the nearest alternative (in <name>.meta.json)',
    },
  ];
}

function readInventoryEntry(component: DiscoveredComponent): InventoryEntry | InventoryViolation {
  const result = readComponentMeta(component.directory, component.name);
  if (!result.ok) return { id: component.name, reason: result.error.reason };
  const { related, avoidWhen, rationale } = result.metadata;
  return {
    id: component.name,
    related,
    avoidWhen,
    ...(rationale === undefined ? {} : { rationale }),
  };
}

export async function checkComponentInventory(): Promise<InventoryViolation[]> {
  const violations: InventoryViolation[] = [];
  const components = await discoverComponentDirectories();
  const knownComponentIds = new Set(components.map((component) => component.name));
  for (const component of components) {
    const entry = readInventoryEntry(component);
    if ('reason' in entry) {
      violations.push(entry);
      continue;
    }
    violations.push(...findNeighbourRationaleViolations(entry, knownComponentIds));
  }
  return violations;
}

if (import.meta.main) {
  const violations = await checkComponentInventory();
  if (violations.length > 0) {
    console.error(`Component inventory neighbour rationale check failed (${violations.length}):`);
    for (const violation of violations) console.error(`- ${violation.id}: ${violation.reason}`);
    process.exit(1);
  }
  console.log('Component inventory neighbour rationale check passed.');
}
