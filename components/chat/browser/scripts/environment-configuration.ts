import { environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  // `1` adds the supplemental profiles to the chat stress capture.
  chatStressSupplemental: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'CHAT_STRESS_SUPPLEMENTAL' }),
});

function selectedEnvironment(): Record<string, string> {
  const value = process.env['CHAT_STRESS_SUPPLEMENTAL'];
  return value === undefined ? {} : { CHAT_STRESS_SUPPLEMENTAL: value };
}

/** Resolve the chat stress capture's process configuration at the point of use. */
export function environmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-chat-stress',
    schema,
    env: selectedEnvironment(),
    sources: ['env', 'defaults'],
    argv: [],
    coerce: false,
  });
}
