import { afterEach, describe, expect, test } from 'bun:test';
import { environmentConfiguration } from './environment-configuration.ts';

const originalPort = process.env['WEFT_UI_PORT'];

afterEach(() => {
  if (originalPort === undefined) delete process.env['WEFT_UI_PORT'];
  else process.env['WEFT_UI_PORT'] = originalPort;
});

describe('browser environment configuration', () => {
  test('preserves Number conversion for empty, invalid, and infinite ports', () => {
    process.env['WEFT_UI_PORT'] = '';
    expect(environmentConfiguration().weftUiPort).toBe(0);

    process.env['WEFT_UI_PORT'] = 'invalid';
    expect(Number.isNaN(environmentConfiguration().weftUiPort)).toBe(true);

    process.env['WEFT_UI_PORT'] = 'Infinity';
    expect(environmentConfiguration().weftUiPort).toBe(Infinity);
  });

  test('uses the default port when the variable is absent', () => {
    delete process.env['WEFT_UI_PORT'];
    expect(environmentConfiguration().weftUiPort).toBeUndefined();
  });
});
