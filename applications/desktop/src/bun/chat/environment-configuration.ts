import { environmentalist, secret } from '@lostgradient/environmentalist';
import { z } from 'zod';

const environmentSchema = z.object({
  anthropicApiKey: secret(z.string().optional()).meta({ env: 'ANTHROPIC_API_KEY' }),
  anthropicBaseUrl: z.string().optional().meta({ env: 'ANTHROPIC_BASE_URL' }),
});

/**
 * The one registered place this application reads the process environment, as
 * `scripts/environment-configuration-policy.ts` at the workspace root
 * enforces. The old SvelteKit lab read these through `$env/dynamic/private`;
 * here the main process owns them directly, because there is no server
 * runtime between the provider call and the process that makes it.
 *
 * Resolved at call time rather than at module load so a key exported into an
 * already-running development session is picked up by the next turn.
 */
export function readEnvironmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-desktop',
    schema: environmentSchema,
    env: {
      ...(process.env['ANTHROPIC_API_KEY'] !== undefined
        ? { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] }
        : {}),
      ...(process.env['ANTHROPIC_BASE_URL'] !== undefined
        ? { ANTHROPIC_BASE_URL: process.env['ANTHROPIC_BASE_URL'] }
        : {}),
    },
    argv: [],
    coerce: false,
    sources: ['env', 'defaults'],
  });
}

export type EnvironmentConfiguration = ReturnType<typeof readEnvironmentConfiguration>;
