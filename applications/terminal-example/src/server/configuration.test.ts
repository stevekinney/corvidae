import { describe, expect, test } from 'bun:test';

import {
  ConfigurationError,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  parseConfiguration,
  servedOrigin,
} from './configuration.ts';

function refusal(argumentsList: string[]): string {
  try {
    parseConfiguration(argumentsList);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as ConfigurationError).message;
  }
  throw new Error('expected the configuration to be refused');
}

describe('parseConfiguration', () => {
  test('defaults to 127.0.0.1 and the documented port', () => {
    expect(parseConfiguration([])).toMatchObject({
      hostname: DEFAULT_HOSTNAME,
      port: DEFAULT_PORT,
    });
    expect(DEFAULT_HOSTNAME).toBe('127.0.0.1');
  });

  test('accepts loopback hostnames in both flag forms', () => {
    expect(parseConfiguration(['--hostname', 'localhost', '--port', '8080'])).toMatchObject({
      hostname: 'localhost',
      port: 8080,
    });
    expect(parseConfiguration(['--hostname=127.0.0.2', '--port=9'])).toMatchObject({
      hostname: '127.0.0.2',
      port: 9,
    });
    expect(parseConfiguration(['--hostname', '[::1]']).hostname).toBe('::1');
  });

  test.each(['0.0.0.0', '::', '192.168.1.20', 'example.com', ''])(
    'refuses the non-loopback hostname %p with an explanation',
    (hostname) => {
      const message = refusal(['--hostname', hostname === '' ? '=' : hostname]);
      expect(message).toContain('loopback');
    },
  );

  test('names the refused hostname and what is allowed', () => {
    const message = refusal(['--hostname=0.0.0.0']);
    expect(message).toContain('Refusing to bind "0.0.0.0"');
    expect(message).toContain('127.0.0.1, ::1 or localhost');
  });

  test.each(['0', '65536', '-1', '80.5', 'abc', ''])('refuses the port %p', (port) => {
    expect(refusal([`--port=${port}`])).toContain('Invalid port');
  });

  test('refuses unknown, repeated and valueless options', () => {
    expect(refusal(['--host', 'x'])).toContain('Unknown option --host');
    expect(refusal(['--port', '1', '--port', '2'])).toContain('more than once');
    expect(refusal(['--port'])).toContain('needs a value');
    expect(refusal(['--hostname', '--port', '1'])).toContain('needs a value');
  });
});

describe('the start token and the browsers it admits', () => {
  test('defaults to no chosen token and one browser', () => {
    expect(parseConfiguration([])).toMatchObject({ startToken: undefined, browsers: 1 });
  });

  test('takes a chosen token and a number of browsers', () => {
    expect(
      parseConfiguration(['--start-token', 'a-token-of-some-length', '--browsers', '64']),
    ).toMatchObject({ startToken: 'a-token-of-some-length', browsers: 64 });
  });

  test('refuses a token too short to guard anything, and a bad browser count', () => {
    expect(refusal(['--start-token', 'short'])).toContain('at least 16');
    expect(refusal(['--browsers', '0'])).toContain('Invalid --browsers');
    expect(refusal(['--browsers', '1000'])).toContain('Invalid --browsers');
    expect(refusal(['--browsers', 'many'])).toContain('Invalid --browsers');
  });
});

describe('servedOrigin', () => {
  test('is the one origin a browser sees', () => {
    expect(
      servedOrigin({ hostname: '127.0.0.1', port: 54240, startToken: undefined, browsers: 1 }),
    ).toBe('http://127.0.0.1:54240');
    expect(servedOrigin({ hostname: '::1', port: 80, startToken: undefined, browsers: 1 })).toBe(
      'http://[::1]:80',
    );
  });
});
