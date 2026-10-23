/**
 * The example prompts an agent suggests, as one schema for every boundary that carries them: an
 * agent file's `examples` frontmatter, the persisted definition, and `bureau.agents.list`. The
 * limits are Operative's (`AGENT_EXAMPLE_LIMITS`), the ones `createAgent` enforces, so a code agent
 * and a file agent are held to the same bounds.
 */
import { AGENT_EXAMPLE_LIMITS } from '@lostgradient/operative';
import { z } from 'zod';

/** At most {@link AGENT_EXAMPLE_LIMITS} prompts, each non-blank and no longer than the limit. */
export const agentExamplesSchema = z
  .array(
    z
      .string()
      .max(AGENT_EXAMPLE_LIMITS.maxLength)
      .refine((prompt) => prompt.trim() !== '', { message: 'An example must not be blank.' }),
  )
  .max(AGENT_EXAMPLE_LIMITS.maxPrompts);
