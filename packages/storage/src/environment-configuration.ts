import { createEnvironmentRecordSource, environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  keepDurabilityFixtures: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_KEEP_DURABILITY_FIXTURES' }),
});

const source = createEnvironmentRecordSource({ schema });

/**
 * Resolve the storage package's settings from the environment without requiring a server runtime.
 *
 * @returns the resolved settings, with `keepDurabilityFixtures` true when
 *   `WEFT_KEEP_DURABILITY_FIXTURES=1`
 */
export function resolveStorageEnvironment() {
  return environmentalist.sync({
    name: 'storage',
    schema,
    sources: [source, 'defaults'],
    argv: [],
    coerce: false,
  });
}
