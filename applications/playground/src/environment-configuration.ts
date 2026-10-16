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
// this source reads `process.env` directly (the `testing/testing` precedent).
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

/** Names of connection strings, which can embed a password (`DATABASE_URL`, `NEON_DATABASE_URL`). */
const CONNECTION_NAME_PATTERN = '.*DATABASE_URL|.*_DSN|.*CONNECTION_STRING|.*_CONNECTION_URL';

/**
 * Package-manager registry credentials: `npm_config_*` names carrying an auth token, basic auth,
 * or a password (`npm_config__authToken`, `npm_config_//host/:_authToken`, `NPM_CONFIG__AUTH`),
 * and `NODE_AUTH_TOKEN`. npm and Bun accept these in any case, so this one class matches
 * case-insensitively; the rest stay case-sensitive so Bun's lowercase `npm_*` script metadata
 * (`npm_package_name`, `npm_lifecycle_event`) is kept.
 */
export const PACKAGE_MANAGER_CREDENTIAL_NAME =
  /^(npm_config_.*(auth|password).*|node_auth_token)$/i;

/**
 * Names that can carry a credential. The static production gate scrubs every matching variable
 * from the environment it gives its child processes (the static server, and Playwright with its
 * browsers), and also any variable whose value is a URL carrying a password. Its served-byte leak
 * check scans the narrower {@link SECRET_VALUE_NAME} set plus the password of any such URL.
 * Case-sensitive on purpose: Bun's lowercase `npm_*` script variables, `HOME`, and `PATH` stay.
 */
export const SECRET_ENVIRONMENT_NAME = new RegExp(
  `^(VERCEL_.*|ANTHROPIC_.*|LINEAR_.*|${CONNECTION_NAME_PATTERN}|.*(${SECRET_NAME_CLASSES}).*)$`,
);

/**
 * Names that hold a secret value, as opposed to public deployment metadata. Narrower than
 * {@link SECRET_ENVIRONMENT_NAME}: `VERCEL_ENV=production` is stripped from child environments
 * but is not a secret, and scanning served bytes for `production` would fail on authored prose.
 */
export const SECRET_VALUE_NAME = new RegExp(`(${SECRET_NAME_CLASSES})`);

type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

/**
 * Every form of the password a `scheme://user:password@host` value carries: the percent-encoded
 * form as written, then the decoded form when it differs. Either form can reach served bytes, so
 * the leak check scans both. A malformed escape cannot be decoded, but the value still carries a
 * password, so it yields the written form alone rather than passing as credential-free. Only the
 * password is a secret: scanning the whole URL would flag a public origin such as
 * `PLAYGROUND_BASE_URL`.
 */
export function urlPasswords(value: string): string[] {
  if (!value.includes('://')) return [];
  let password: string;
  try {
    password = new URL(value).password;
  } catch {
    return [];
  }
  if (password === '') return [];
  try {
    const decoded = decodeURIComponent(password);
    return decoded === password ? [password] : [password, decoded];
  } catch {
    return [password];
  }
}

/** The secret values in `environment` the served-byte leak check scans for. */
export function secretEntriesOf(environment: EnvironmentRecord): [name: string, value: string][] {
  return Object.entries(environment).flatMap(([name, value]): [string, string][] => {
    if (value === undefined) return [];
    if (SECRET_VALUE_NAME.test(name) || PACKAGE_MANAGER_CREDENTIAL_NAME.test(name)) {
      return [[name, value]];
    }
    return urlPasswords(value).map((password): [string, string] => [name, password]);
  });
}

/** Whether a variable is withheld from the gate's child processes. */
export function isCredentialShaped(name: string, value: string): boolean {
  return (
    SECRET_ENVIRONMENT_NAME.test(name) ||
    PACKAGE_MANAGER_CREDENTIAL_NAME.test(name) ||
    urlPasswords(value).length > 0
  );
}

/** `environment` with every credential-shaped variable removed. */
export function scrubbedEnvironmentOf(environment: EnvironmentRecord): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value !== undefined && !isCredentialShaped(name, value) ? [[name, value]] : [],
    ),
  );
}

/** Every secret value in this process's environment, for the served-byte leak check. */
export function readSecretEnvironmentEntries(): [name: string, value: string][] {
  return secretEntriesOf(process.env);
}

/** The names of every credential-shaped variable in this process's environment. */
export function readCredentialShapedNames(): string[] {
  return Object.entries(process.env).flatMap(([name, value]) =>
    value !== undefined && isCredentialShaped(name, value) ? [name] : [],
  );
}

/** The current environment with every credential-shaped variable removed. */
export function readScrubbedEnvironment(): Record<string, string> {
  return scrubbedEnvironmentOf(process.env);
}
