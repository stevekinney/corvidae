import { environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  browserPort: z.string().optional().meta({ env: 'PLAYGROUND_BROWSER_PORT' }),
  browserReuse: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'PLAYGROUND_BROWSER_REUSE' }),
  browserStatic: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'PLAYGROUND_BROWSER_STATIC' }),
  browserStaticPort: z.string().optional().meta({ env: 'PLAYGROUND_BROWSER_STATIC_PORT' }),
});

const NAMES = [
  'PLAYGROUND_BROWSER_PORT',
  'PLAYGROUND_BROWSER_REUSE',
  'PLAYGROUND_BROWSER_STATIC',
  'PLAYGROUND_BROWSER_STATIC_PORT',
];

function selectedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    NAMES.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

/** Resolve the playground's browser-test process configuration at the point of use. */
export function environmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-playground-browser',
    schema,
    env: selectedEnvironment(),
    sources: ['env', 'defaults'],
    argv: [],
    coerce: false,
  });
}
