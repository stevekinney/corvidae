import { afterEach, expect, test } from 'bun:test';
import { readEnvironmentConfiguration } from '../../src/environment-configuration.ts';
import { resolveGeminiApiKey } from '../../src/providers/gemini-api-key.ts';

const originalGoogleKey = process.env['GOOGLE_API_KEY'];

afterEach(() => {
  if (originalGoogleKey === undefined) delete process.env['GOOGLE_API_KEY'];
  else process.env['GOOGLE_API_KEY'] = originalGoogleKey;
});

test('provider configuration stays lazy and preserves exact names and empty values', () => {
  delete process.env['GOOGLE_API_KEY'];
  expect(readEnvironmentConfiguration().googleApiKey).toBeUndefined();
  process.env['GOOGLE_API_KEY'] = 'first-key';
  const first = readEnvironmentConfiguration();
  process.env['GOOGLE_API_KEY'] = '';
  expect(readEnvironmentConfiguration().googleApiKey).toBe('');
  expect(first.googleApiKey).toBe('first-key');
});

test('credentials remain usable but are redacted during serialization', () => {
  process.env['GOOGLE_API_KEY'] = 'private-test-key';
  const configuration = readEnvironmentConfiguration();
  expect(configuration.googleApiKey).toBe('private-test-key');
  expect(JSON.stringify(configuration)).not.toContain('private-test-key');
  expect(JSON.stringify(configuration)).toContain('[redacted]');
});

test('explicit provider keys retain precedence including explicit empty values', () => {
  process.env['GOOGLE_API_KEY'] = 'environment-key';
  expect(resolveGeminiApiKey('explicit-key')).toBe('explicit-key');
  expect(resolveGeminiApiKey(undefined)).toBe('environment-key');
  expect(() => resolveGeminiApiKey('')).toThrow('Missing API key');
  delete process.env['GOOGLE_API_KEY'];
  expect(() => resolveGeminiApiKey(undefined)).toThrow('Missing API key');
});
