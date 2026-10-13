import { environmentalist } from '@lostgradient/environmentalist';
import type { Source } from '@lostgradient/environmentalist/types';
import { z } from 'zod';

const environmentSchema = z.object({
  cinderTestComponents: z.string().optional().meta({ env: 'CINDER_TEST_COMPONENTS' }),
  nodeEnv: z.string().optional().meta({ env: 'NODE_ENV' }),
  playgroundBaseUrl: z.string().optional().meta({ env: 'PLAYGROUND_BASE_URL' }),
  playgroundLifecycleRequireReaped: z
    .string()
    .optional()
    .meta({ env: 'PLAYGROUND_LIFECYCLE_REQUIRE_REAPED' }),
  playgroundPortFile: z.string().optional().meta({ env: 'PLAYGROUND_PORT_FILE' }),
  playgroundStaticBaseUrl: z.string().optional().meta({ env: 'PLAYGROUND_STATIC_BASE_URL' }),
  playgroundStaticCases: z.string().optional().meta({ env: 'PLAYGROUND_STATIC_CASES' }),
  playgroundStaticResults: z.string().optional().meta({ env: 'PLAYGROUND_STATIC_RESULTS' }),
  playgroundStaticScratch: z.string().optional().meta({ env: 'PLAYGROUND_STATIC_SCRATCH' }),
  playgroundStaticScreenshots: z.string().optional().meta({ env: 'PLAYGROUND_STATIC_SCREENSHOTS' }),
  port: z.string().optional().meta({ env: 'PORT' }),
  vercelGitCommitSha: z.string().optional().meta({ env: 'VERCEL_GIT_COMMIT_SHA' }),
});

const keyByEnvironmentName: Record<string, keyof z.infer<typeof environmentSchema>> = {
  CINDER_TEST_COMPONENTS: 'cinderTestComponents',
  NODE_ENV: 'nodeEnv',
  PLAYGROUND_BASE_URL: 'playgroundBaseUrl',
  PLAYGROUND_LIFECYCLE_REQUIRE_REAPED: 'playgroundLifecycleRequireReaped',
  PLAYGROUND_PORT_FILE: 'playgroundPortFile',
  PLAYGROUND_STATIC_BASE_URL: 'playgroundStaticBaseUrl',
  PLAYGROUND_STATIC_CASES: 'playgroundStaticCases',
  PLAYGROUND_STATIC_RESULTS: 'playgroundStaticResults',
  PLAYGROUND_STATIC_SCRATCH: 'playgroundStaticScratch',
  PLAYGROUND_STATIC_SCREENSHOTS: 'playgroundStaticScreenshots',
  PORT: 'port',
  VERCEL_GIT_COMMIT_SHA: 'vercelGitCommitSha',
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

/**
 * Names that can carry a credential. The static production gate removes every matching variable
 * before its credential-independent run, and fails when a matching value appears in served output.
 * Case-sensitive on purpose: Bun's lowercase `npm_*` script variables, `HOME`, and `PATH` stay.
 */
export const SECRET_ENVIRONMENT_NAME =
  /^(VERCEL_.*|.*TOKEN.*|.*SECRET.*|.*PASSWORD.*|.*API_KEY.*|ANTHROPIC_.*|LINEAR_.*)$/;

/** Every set variable whose name matches {@link SECRET_ENVIRONMENT_NAME}, for the leak check. */
export function readSecretEnvironmentEntries(): [name: string, value: string][] {
  return Object.entries(process.env).flatMap(([name, value]) =>
    value !== undefined && SECRET_ENVIRONMENT_NAME.test(name) ? [[name, value]] : [],
  );
}

/** The current environment with every credential-shaped variable removed. */
export function readScrubbedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value !== undefined && !SECRET_ENVIRONMENT_NAME.test(name) ? [[name, value]] : [],
    ),
  );
}

/** The current environment, for forwarding to a child process with additions. */
export function readProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}
