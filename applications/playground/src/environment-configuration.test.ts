import { afterEach, describe, expect, it } from 'bun:test';

import { readEnvironmentConfiguration } from './environment-configuration.ts';

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
