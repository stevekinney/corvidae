import { afterEach, describe, expect, it } from 'bun:test';

import {
  readEnvironmentConfiguration,
  scrubbedEnvironmentOf,
  secretEntriesOf,
  urlPassword,
} from './environment-configuration.ts';

const VARIABLES = [
  'CINDER_TEST_COMPONENTS',
  'NODE_ENV',
  'PLAYGROUND_BASE_URL',
  'PLAYGROUND_PORT_FILE',
  'PORT',
] as const;

/**
 * Record a variable's current value and return the function that puts it back,
 * deleting the variable when it was unset to begin with.
 */
function captureOriginal(name: string): () => void {
  const original = process.env[name];
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  };
}

const restorers = VARIABLES.map(captureOriginal);

function restoreEnvironment(): void {
  for (const restore of restorers) restore();
}

function clearEnvironment(): void {
  for (const name of VARIABLES) delete process.env[name];
}

afterEach(restoreEnvironment);

describe('readEnvironmentConfiguration', () => {
  it('reads PORT from the process environment under the browser export condition', () => {
    clearEnvironment();
    Bun.env['PORT'] = '4321';
    expect(readEnvironmentConfiguration().port).toBe('4321');
  });

  it('reads PLAYGROUND_BASE_URL', () => {
    clearEnvironment();
    process.env['PLAYGROUND_BASE_URL'] = 'https://example.test';
    expect(readEnvironmentConfiguration().playgroundBaseUrl).toBe('https://example.test');
  });

  it('reads PLAYGROUND_PORT_FILE', () => {
    clearEnvironment();
    process.env['PLAYGROUND_PORT_FILE'] = '/tmp/playground.port';
    expect(readEnvironmentConfiguration().playgroundPortFile).toBe('/tmp/playground.port');
  });

  it('reads CINDER_TEST_COMPONENTS', () => {
    clearEnvironment();
    process.env['CINDER_TEST_COMPONENTS'] = 'button,input';
    expect(readEnvironmentConfiguration().cinderTestComponents).toBe('button,input');
  });

  it('reads NODE_ENV', () => {
    clearEnvironment();
    process.env['NODE_ENV'] = 'production';
    expect(readEnvironmentConfiguration().nodeEnv).toBe('production');
  });

  it('leaves every value undefined when nothing is set', () => {
    clearEnvironment();
    const configuration = readEnvironmentConfiguration();
    expect(configuration.cinderTestComponents).toBeUndefined();
    expect(configuration.nodeEnv).toBeUndefined();
    expect(configuration.playgroundBaseUrl).toBeUndefined();
    expect(configuration.playgroundPortFile).toBeUndefined();
    expect(configuration.port).toBeUndefined();
  });

  it('re-reads the environment on every call instead of caching', () => {
    clearEnvironment();
    process.env['PORT'] = '1111';
    expect(readEnvironmentConfiguration().port).toBe('1111');
    process.env['PORT'] = '2222';
    expect(readEnvironmentConfiguration().port).toBe('2222');
  });
});

describe('package-manager credentials', () => {
  const environment = {
    npm_config__authToken: 'npm-registry-token',
    'npm_config_//registry.example/:_authToken': 'scoped-registry-token',
    NPM_CONFIG__AUTH: 'basic-auth-credential',
    npm_config_password: 'registry-password',
    NODE_AUTH_TOKEN: 'node-auth-token',
    npm_config_cache: '/Users/example/.npm',
    npm_package_name: '@lostgradient/playground',
    npm_lifecycle_event: 'test',
  };

  it('scrubs registry credentials from child environments, case-insensitively', () => {
    expect(scrubbedEnvironmentOf(environment)).toEqual({
      npm_config_cache: '/Users/example/.npm',
      npm_package_name: '@lostgradient/playground',
      npm_lifecycle_event: 'test',
    });
  });

  it('scans their values, and never Bun and npm script metadata', () => {
    expect(secretEntriesOf(environment).map(([name]) => name)).toEqual([
      'npm_config__authToken',
      'npm_config_//registry.example/:_authToken',
      'NPM_CONFIG__AUTH',
      'npm_config_password',
      'NODE_AUTH_TOKEN',
    ]);
  });
});

describe('credential-bearing connection strings', () => {
  const environment = {
    DATABASE_URL: 'postgres://playground:database-password@db.example/app',
    NEON_DATABASE_URL: 'postgres://neon:neon-password@neon.example/app',
    ANALYTICS_DSN: 'https://public@sentry.example/1',
    SERVICE_CONNECTION_URL: 'https://service.example',
    PLAYGROUND_BASE_URL: 'https://cinder.website',
    UNNAMED_URL: 'https://user:unnamed-password@host.example/',
    HOME: '/Users/example',
  };

  it('scrubs connection-string names and any URL carrying a password from child environments', () => {
    expect(scrubbedEnvironmentOf(environment)).toEqual({
      PLAYGROUND_BASE_URL: 'https://cinder.website',
      HOME: '/Users/example',
    });
  });

  it('scans the password of every URL that carries one, and never a public origin', () => {
    expect(secretEntriesOf(environment)).toEqual([
      ['DATABASE_URL', 'database-password'],
      ['NEON_DATABASE_URL', 'neon-password'],
      ['UNNAMED_URL', 'unnamed-password'],
    ]);
  });

  it.each([
    ['https://cinder.website', undefined],
    ['https://user@host.example', undefined],
    ['postgres://user:p%40ss@host/db', 'p@ss'],
    ['not a url: really', undefined],
  ])('reads the password of %s as %s', (value, password) => {
    expect(urlPassword(value)).toBe(password);
  });
});
