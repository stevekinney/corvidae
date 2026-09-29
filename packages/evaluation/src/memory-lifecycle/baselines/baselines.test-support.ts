import { createManualRuntimeServices } from '@lostgradient/operative';

import { memoryLifecycleEnvelope } from '../envelope';
import type { ScenarioEvidence } from '../scenarios';
import type { BaselineOptions, MemoryBaselineAdapter } from './adapter';

/** Shared fixtures for the baseline adapter tests. */

export const ORIGIN = '2026-01-01T00:00:00.000Z';

export function baselineOptions(): BaselineOptions & {
  readonly runtime: ReturnType<typeof createManualRuntimeServices>;
} {
  return {
    runtime: createManualRuntimeServices({ origin: ORIGIN, identifierSeed: 'baseline-tests' }),
    envelope: memoryLifecycleEnvelope('deterministic'),
  };
}

/** One piece of owner conversation evidence, with `changes` applied. */
export function evidence(
  id: string,
  content: string,
  changes: Partial<ScenarioEvidence> = {},
): ScenarioEvidence {
  return {
    id,
    principal: 'owner',
    source: 'conversation',
    kind: 'fact',
    modality: 'text',
    label: 'relevant',
    content,
    ...changes,
  };
}

/** The contents a recall returns, in order. */
export async function recalledContents(
  adapter: MemoryBaselineAdapter,
  query: string,
  limit = 5,
): Promise<string[]> {
  const { items } = await adapter.recall({ query, limit });
  return items.map((item) => item.content);
}
