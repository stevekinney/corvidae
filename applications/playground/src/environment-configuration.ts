import { environmentalist } from '@lostgradient/environmentalist';
import type { Source } from '@lostgradient/environmentalist/types';
import { z } from 'zod';

const environmentSchema = z.object({
  cinderTestComponents: z.string().optional().meta({ env: 'CINDER_TEST_COMPONENTS' }),
  nodeEnv: z.string().optional().meta({ env: 'NODE_ENV' }),
  playgroundBaseUrl: z.string().optional().meta({ env: 'PLAYGROUND_BASE_URL' }),
  playgroundPortFile: z.string().optional().meta({ env: 'PLAYGROUND_PORT_FILE' }),
  port: z.string().optional().meta({ env: 'PORT' }),
});

const keyByEnvironmentName: Record<string, keyof z.infer<typeof environmentSchema>> = {
  CINDER_TEST_COMPONENTS: 'cinderTestComponents',
  NODE_ENV: 'nodeEnv',
  PLAYGROUND_BASE_URL: 'playgroundBaseUrl',
  PLAYGROUND_PORT_FILE: 'playgroundPortFile',
  PORT: 'port',
};

// Environmentalist's built-in `env` source reads nothing under the `browser`
// export condition, which the playground's tests and bundles run under, so
// this source reads `process.env` directly (the `packages/testing` precedent).
const environmentSource: Source = {
  id: 'corvidae-playground-process-env',
  kind: 'string',
  load: () => loadEnvironment(),
  loadSync: () => loadEnvironment(),
};

function loadEnvironment() {
  const values: Record<string, string> = {};
  for (const [name, key] of Object.entries(keyByEnvironmentName)) {
    const value = process.env[name];
    if (value !== undefined) values[key] = value;
  }
  return Object.keys(values).length === 0 ? undefined : { values, location: 'process.env' };
}

export function readEnvironmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-playground',
    schema: environmentSchema,
    sources: [environmentSource, 'defaults'],
    argv: [],
    coerce: false,
  });
}
