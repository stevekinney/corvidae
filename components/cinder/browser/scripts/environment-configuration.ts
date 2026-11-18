import { environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  // Where `verify-curated-build.ts` built the curated highlighter fixture for its test to read.
  curatedHighlighterOutputDirectory: z
    .string()
    .optional()
    .meta({ env: 'CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY' }),
});

function selectedEnvironment(): Record<string, string> {
  const value = process.env['CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY'];
  return value === undefined ? {} : { CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY: value };
}

/** Resolve the curated highlighter check's process configuration at the point of use. */
export function environmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-curated-highlighter',
    schema,
    env: selectedEnvironment(),
    sources: ['env', 'defaults'],
    argv: [],
    coerce: false,
  });
}
