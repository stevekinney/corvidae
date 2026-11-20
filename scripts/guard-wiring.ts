/** Ensures required root checks remain connected to the executable lint command graph. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findGateInvocations } from '../internal/component-tooling/scripts/gate-wiring.ts';

export const REQUIRED_GUARDS = ['scripts/run-knip.ts', 'scripts/guard-wiring.ts'] as const;

export function missingRequiredGuards(scripts: Readonly<Record<string, string>>): string[] {
  const invocations = new Set(findGateInvocations(scripts, ['lint:root']));
  return REQUIRED_GUARDS.filter((guard) => ![...invocations].some((command) => command === guard));
}

function main(): void {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
  ) as {
    scripts: Record<string, string>;
  };
  const missing = missingRequiredGuards(manifest.scripts);
  for (const guard of missing)
    process.stderr.write(`guard-wiring — ${guard} is disconnected from lint:root.\n`);
  if (missing.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
