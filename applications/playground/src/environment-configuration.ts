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
 * Name fragments that mark a secret value. Both predicates below are built from this one list,
 * so the child-environment scrub can never fall behind the served-byte leak scan.
 */
const SECRET_NAME_CLASSES = 'TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|PRIVATE_KEY|CREDENTIAL';

/**
 * Names that can carry a credential. The static production gate scrubs every matching variable
 * from the environment it gives its child processes (the static server, and Playwright with its
 * browsers). Its served-byte leak check scans only the narrower {@link SECRET_VALUE_NAME} set. Case-sensitive on purpose: Bun's lowercase `npm_*` script variables, `HOME`, and
 * `PATH` stay.
 */
export const SECRET_ENVIRONMENT_NAME = new RegExp(
  `^(VERCEL_.*|ANTHROPIC_.*|LINEAR_.*|.*(${SECRET_NAME_CLASSES}).*)$`,
);

/**
 * Names that hold a secret value, as opposed to public deployment metadata. Narrower than
 * {@link SECRET_ENVIRONMENT_NAME}: `VERCEL_ENV=production` is stripped from child environments
 * but is not a secret, and scanning served bytes for `production` would fail on authored prose.
 */
export const SECRET_VALUE_NAME = new RegExp(`(${SECRET_NAME_CLASSES})`);

/** Every set variable whose name marks a secret value, for the served-byte leak check. */
export function readSecretEnvironmentEntries(): [name: string, value: string][] {
  return Object.entries(process.env).flatMap(([name, value]) =>
    value !== undefined && SECRET_VALUE_NAME.test(name) ? [[name, value]] : [],
  );
}

/** The names of every set variable matching {@link SECRET_ENVIRONMENT_NAME}. */
export function readCredentialShapedNames(): string[] {
  return Object.keys(process.env).filter(
    (name) => process.env[name] !== undefined && SECRET_ENVIRONMENT_NAME.test(name),
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
