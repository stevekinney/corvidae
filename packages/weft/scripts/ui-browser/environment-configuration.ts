import { environmentalist } from '@lostgradient/environmentalist';
import type { Source } from '@lostgradient/environmentalist/types';
import { z } from 'zod';

const schema = z.object({
  ci: z
    .string()
    .optional()
    .transform((value) => Boolean(value))
    .meta({ env: 'CI' }),
  weftApiBaseUrl: z.string().optional().meta({ env: 'WEFT_API_BASE_URL' }),
  browserHostPort: z.string().transform(Number).optional().meta({ env: 'WEFT_UI_PORT' }),
});

const environmentSource: Source = {
  id: 'weft-ui-process-env',
  kind: 'string',
  load: () => loadEnvironment(),
  loadSync: () => loadEnvironment(),
};

function loadEnvironment() {
  const values: Record<string, string> = {};
  const environmentNames = {
    ci: 'CI',
    weftApiBaseUrl: 'WEFT_API_BASE_URL',
    browserHostPort: 'WEFT_UI_PORT',
  } as const;
  for (const [key, name] of Object.entries(environmentNames)) {
    const value = typeof process === 'undefined' ? undefined : process.env[name];
    if (value !== undefined) values[key] = value;
  }
  return Object.keys(values).length === 0 ? undefined : { values, location: 'process.env' };
}

/** Resolve the Weft UI browser harness configuration at the point of use. */
export function environmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-weft-ui-browser',
    schema,
    sources: [environmentSource, 'defaults'],
    argv: [],
    coerce: false,
  });
}
