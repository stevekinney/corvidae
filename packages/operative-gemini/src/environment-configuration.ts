import {
  createEnvironmentRecordSource,
  environmentalist,
  secret,
} from '@lostgradient/environmentalist';
import { z } from 'zod';

const environmentSchema = z.object({
  googleApiKey: secret(z.string().optional()).meta({ env: 'GOOGLE_API_KEY' }),
});

const runtimeEnvironmentSource = createEnvironmentRecordSource({ schema: environmentSchema });

/**
 * Resolve the Gemini provider's environment configuration without assuming Bun or Node globals
 * exist. `googleApiKey` is the `GOOGLE_API_KEY` value, redacted when the configuration is
 * serialized.
 */
export function readEnvironmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-operative-gemini',
    schema: environmentSchema,
    argv: [],
    coerce: false,
    sources: [runtimeEnvironmentSource, 'defaults'],
  });
}

/** The Gemini provider's resolved environment configuration. */
export type EnvironmentConfiguration = ReturnType<typeof readEnvironmentConfiguration>;
