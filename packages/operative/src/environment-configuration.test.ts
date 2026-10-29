import { afterEach, expect, test } from 'bun:test';
import { readEnvironmentConfiguration } from './environment-configuration.ts';

const originalBaseUrl = process.env['OPENAI_BASE_URL'];
const originalCollision = process.env['openai_base_url'];

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env['OPENAI_BASE_URL'];
  else process.env['OPENAI_BASE_URL'] = originalBaseUrl;
  if (originalCollision === undefined) delete process.env['openai_base_url'];
  else process.env['openai_base_url'] = originalCollision;
});

test('provider configuration stays lazy and preserves exact names and empty values', () => {
  delete process.env['OPENAI_BASE_URL'];
  process.env['openai_base_url'] = 'https://unrelated.invalid';
  expect(readEnvironmentConfiguration().openaiBaseUrl).toBeUndefined();
  process.env['OPENAI_BASE_URL'] = 'https://first.invalid';
  const first = readEnvironmentConfiguration();
  process.env['OPENAI_BASE_URL'] = '';
  expect(readEnvironmentConfiguration().openaiBaseUrl).toBe('');
  expect(first.openaiBaseUrl).toBe('https://first.invalid');
});
