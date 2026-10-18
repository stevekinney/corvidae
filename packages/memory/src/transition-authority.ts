import { z } from 'zod';

import { nonEmpty, principalSchema } from './evidence-schema-primitives';
import {
  MEMORY_CAPABILITIES,
  MEMORY_PROJECTIONS,
  type MemoryAuthority,
  type MemoryCapability,
} from './governance/authority';

const capabilitySchema = z.enum(MEMORY_CAPABILITIES as [MemoryCapability, ...MemoryCapability[]]);

/**
 * `MemoryAuthority`, as a transition proposal and a transition receipt persist
 * it: a strict mirror of the governance authority schema, so an unknown key is
 * refused instead of silently dropped and the digest of a proposal does not move
 * with a field the authority never declared. It checks shape only; the engine
 * calls `assertMemoryAuthority` before it decides anything, because the delegation
 * chain's rules are not shape.
 */
export const memoryAuthoritySchema: z.ZodType<MemoryAuthority> = z
  .object({
    principal: principalSchema,
    tenantId: nonEmpty,
    ownerId: nonEmpty,
    purpose: nonEmpty,
    capabilities: z.array(capabilitySchema),
    delegationChain: z
      .array(
        z.object({ principal: principalSchema, capabilities: z.array(capabilitySchema) }).strict(),
      )
      .min(1),
    policyRevision: nonEmpty,
    projection: z.enum(MEMORY_PROJECTIONS),
  })
  .strict();
