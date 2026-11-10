import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  designReviewCaptureDirectory,
  designReviewColorScheme,
  endToEndPort,
  endToEndPortOverride,
  isContinuousIntegration,
  requiresFreshServer,
} from './environment-configuration.ts';

describe('the end-to-end port', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env['INTERBOROUGH_E2E_PORT'];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['INTERBOROUGH_E2E_PORT'];
    else process.env['INTERBOROUGH_E2E_PORT'] = saved;
  });

  test('is 7399 when nothing sets it', () => {
    delete process.env['INTERBOROUGH_E2E_PORT'];
    expect(endToEndPort()).toBe(7399);
    process.env['INTERBOROUGH_E2E_PORT'] = '';
    expect(endToEndPort()).toBe(7399);
  });

  test('has no override unless the environment names a port, and refuses one that is not a port', () => {
    delete process.env['INTERBOROUGH_E2E_PORT'];
    expect(endToEndPortOverride()).toBeUndefined();
    process.env['INTERBOROUGH_E2E_PORT'] = '';
    expect(endToEndPortOverride()).toBeUndefined();
    process.env['INTERBOROUGH_E2E_PORT'] = '7721';
    expect(endToEndPortOverride()).toBe(7721);
    process.env['INTERBOROUGH_E2E_PORT'] = 'seven';
    expect(() => endToEndPortOverride()).toThrow('INTERBOROUGH_E2E_PORT');
  });

  test('is the port the environment names', () => {
    process.env['INTERBOROUGH_E2E_PORT'] = '7721';
    expect(endToEndPort()).toBe(7721);
  });

  test('leaves room for the five ports the suite holds after it, so the highest is 65530', () => {
    process.env['INTERBOROUGH_E2E_PORT'] = '65530';
    expect(endToEndPort()).toBe(65530);
    process.env['INTERBOROUGH_E2E_PORT'] = '65531';
    expect(() => endToEndPort()).toThrow('below 65531');
  });

  test('refuses a value that is not a port', () => {
    for (const raw of ['0', '-1', '7399.5', 'seven', '70000']) {
      process.env['INTERBOROUGH_E2E_PORT'] = raw;
      expect(() => endToEndPort(), raw).toThrow('INTERBOROUGH_E2E_PORT');
    }
  });
});

describe('the continuous-integration flag', () => {
  test('is on when CI is set to anything and off when it is empty or absent', () => {
    const saved = process.env['CI'];
    try {
      process.env['CI'] = 'true';
      expect(isContinuousIntegration()).toBe(true);
      process.env['CI'] = '';
      expect(isContinuousIntegration()).toBe(false);
      delete process.env['CI'];
      expect(isContinuousIntegration()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['CI'];
      else process.env['CI'] = saved;
    }
  });
});

describe('the design-review capture settings', () => {
  let savedCapture: string | undefined;
  let savedColorScheme: string | undefined;

  beforeEach(() => {
    savedCapture = process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'];
    savedColorScheme = process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'];
  });

  afterEach(() => {
    if (savedCapture === undefined) delete process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'];
    else process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] = savedCapture;
    if (savedColorScheme === undefined)
      delete process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'];
    else process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = savedColorScheme;
  });

  test('capture directory is the one the environment names, and absent for an ordinary run', () => {
    delete process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'];
    expect(designReviewCaptureDirectory()).toBeUndefined();
    process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] = '';
    expect(designReviewCaptureDirectory()).toBeUndefined();
    process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] = '/tmp/design-review/now';
    expect(designReviewCaptureDirectory()).toBe('/tmp/design-review/now');
  });

  test('color scheme is light or dark, absent when unset, and refused otherwise', () => {
    delete process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'];
    expect(designReviewColorScheme()).toBeUndefined();
    process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = '';
    expect(designReviewColorScheme()).toBeUndefined();
    process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = 'light';
    expect(designReviewColorScheme()).toBe('light');
    process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = 'dark';
    expect(designReviewColorScheme()).toBe('dark');
    process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = 'sepia';
    expect(() => designReviewColorScheme()).toThrow('must be light or dark, not "sepia"');
  });
});

describe('the fresh-server flag', () => {
  test('is on when INTERBOROUGH_E2E_FRESH_SERVER is set to anything and off when it is empty or absent', () => {
    const saved = process.env['INTERBOROUGH_E2E_FRESH_SERVER'];
    try {
      process.env['INTERBOROUGH_E2E_FRESH_SERVER'] = '1';
      expect(requiresFreshServer()).toBe(true);
      process.env['INTERBOROUGH_E2E_FRESH_SERVER'] = '';
      expect(requiresFreshServer()).toBe(false);
      delete process.env['INTERBOROUGH_E2E_FRESH_SERVER'];
      expect(requiresFreshServer()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['INTERBOROUGH_E2E_FRESH_SERVER'];
      else process.env['INTERBOROUGH_E2E_FRESH_SERVER'] = saved;
    }
  });
});
