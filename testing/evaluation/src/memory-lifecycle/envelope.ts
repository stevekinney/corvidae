/**
 * The compute envelope (COR-755, "equal model, effort, prompt, tool, token,
 * cost, step, and wall-clock budgets"). One envelope is fixed per lane, and
 * every baseline in that lane runs under exactly it: the same model and
 * effort, the same prompt revision, the same tools, the same embedder for
 * the baselines that embed, the same recall limit and context-token budget,
 * and the same step, cost, and wall-clock ceilings. Its digest is recorded on
 * every run artifact, so a comparison that mixed envelopes is detectable.
 *
 * Tokens and cost are counted deterministically: a context or message costs
 * `ceil(characters / 4)` tokens, priced at the envelope's rates. Wall-clock
 * time is measured and reported, never gated by a deterministic criterion,
 * because it measures the host as much as the memory.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import type { TokenUsage } from '@lostgradient/operative';
import { z } from 'zod';

import { EFFORTS, identifier } from '../configuration';
import { canonicalJson } from '../identity';
import { MEMORY_LIFECYCLE_PROMPT_REVISION } from './prompt';

/** The two lanes: a deterministic reference policy, and a seeded, sampled one. */
export const MEMORY_LIFECYCLE_LANES = ['deterministic', 'stochastic'] as const;
export type MemoryLifecycleLane = (typeof MEMORY_LIFECYCLE_LANES)[number];

/** The tools every scenario agent has, whatever its baseline. */
export const SCENARIO_TOOLS = [
  'memory_recall',
  'environment_action',
  'environment_unknown',
] as const;

const positiveInteger = z.number().int().positive();

export const computeEnvelopeSchema = z.strictObject({
  lane: z.enum(MEMORY_LIFECYCLE_LANES),
  model: z.strictObject({
    provider: identifier,
    name: identifier,
    revision: identifier,
    /** The chance, per decision, that a sampled model departs from the reference choice. */
    noise: z.number().min(0).max(1),
  }),
  effort: z.enum(EFFORTS),
  promptRevision: identifier,
  tools: z.array(identifier).min(1),
  embedder: z.strictObject({ name: identifier, dimension: positiveInteger }),
  recallLimit: positiveInteger,
  maximumContextTokens: positiveInteger,
  maximumSteps: positiveInteger,
  maximumCostUsd: z.number().nonnegative(),
  maximumWallClockMilliseconds: positiveInteger,
  pricing: z.strictObject({
    promptUsdPerMillionTokens: z.number().nonnegative(),
    completionUsdPerMillionTokens: z.number().nonnegative(),
  }),
});

export type ComputeEnvelope = z.output<typeof computeEnvelopeSchema>;

/** The committed envelope for `lane`. The lanes differ only in the model. */
export function memoryLifecycleEnvelope(lane: MemoryLifecycleLane): ComputeEnvelope {
  return computeEnvelopeSchema.parse({
    lane,
    model:
      lane === 'deterministic'
        ? { provider: 'fixture', name: 'reference-policy', revision: '1', noise: 0 }
        : { provider: 'fixture', name: 'sampled-reference-policy', revision: '1', noise: 0.2 },
    effort: 'medium',
    promptRevision: MEMORY_LIFECYCLE_PROMPT_REVISION,
    tools: [...SCENARIO_TOOLS],
    embedder: { name: 'lexical-hash', dimension: 256 },
    recallLimit: 3,
    maximumContextTokens: 160,
    maximumSteps: 4,
    maximumCostUsd: 0.01,
    maximumWallClockMilliseconds: 5_000,
    pricing: { promptUsdPerMillionTokens: 3, completionUsdPerMillionTokens: 15 },
  });
}

/** The SHA-256 of an envelope's canonical JSON. */
export function envelopeDigest(envelope: ComputeEnvelope): Promise<string> {
  return sha256Hex(canonicalJson(envelope));
}

/** The deterministic token count of `text`: one token per four characters, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** What `usage` costs at the envelope's rates. */
export function costOf(usage: TokenUsage, envelope: ComputeEnvelope): number {
  const { promptUsdPerMillionTokens, completionUsdPerMillionTokens } = envelope.pricing;
  return (
    (usage.prompt * promptUsdPerMillionTokens + usage.completion * completionUsdPerMillionTokens) /
    1_000_000
  );
}
