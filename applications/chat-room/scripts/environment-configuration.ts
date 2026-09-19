import { environmentalist, secret } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  anthropicApiKey: secret(z.string().optional()).meta({ env: 'ANTHROPIC_API_KEY' }),
});

/** Resolve the live script's credential without exposing it in output. */
export function readLiveEnvironmentConfiguration() {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  return environmentalist.sync({
    name: 'corvidae-chat-room-live-script',
    schema,
    env: apiKey === undefined ? {} : { ANTHROPIC_API_KEY: apiKey },
    argv: [],
    coerce: false,
    sources: ['env', 'defaults'],
  });
}
