import { env } from '$env/dynamic/private';
import { environmentalist, secret } from '@lostgradient/environmentalist';
import { z } from 'zod';

const environmentSchema = z.object({
  anthropicApiKey: secret(z.string().optional()).meta({ env: 'ANTHROPIC_API_KEY' }),
  anthropicBaseUrl: z.string().optional().meta({ env: 'ANTHROPIC_BASE_URL' }),
});

/** Resolve the chat-room server environment at call time. */
export function readEnvironmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-chat-room',
    schema: environmentSchema,
    env: {
      ...(env['ANTHROPIC_API_KEY'] !== undefined
        ? { ANTHROPIC_API_KEY: env['ANTHROPIC_API_KEY'] }
        : {}),
      ...(env['ANTHROPIC_BASE_URL'] !== undefined
        ? { ANTHROPIC_BASE_URL: env['ANTHROPIC_BASE_URL'] }
        : {}),
    },
    argv: [],
    coerce: false,
    sources: ['env', 'defaults'],
  });
}

export type EnvironmentConfiguration = ReturnType<typeof readEnvironmentConfiguration>;
