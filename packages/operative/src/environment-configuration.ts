import { createEnvironmentRecordSource, environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const environmentSchema = z.object({
  openaiBaseUrl: z.string().optional().meta({ env: 'OPENAI_BASE_URL' }),
});

const runtimeEnvironmentSource = createEnvironmentRecordSource({ schema: environmentSchema });

/** Resolve provider configuration without assuming `process` exists. */
export function readEnvironmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-operative',
    schema: environmentSchema,
    argv: [],
    coerce: false,
    sources: [runtimeEnvironmentSource, 'defaults'],
  });
}

export type EnvironmentConfiguration = ReturnType<typeof readEnvironmentConfiguration>;
