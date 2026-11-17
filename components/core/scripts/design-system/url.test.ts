import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  configurationPath,
  readConfiguredUrl,
  saveConfiguredUrl,
  URL_ENVIRONMENT_VARIABLE,
} from './url.ts';

const url = 'https://claude.ai/artifact/AbC123';
let directory: string | undefined;

afterEach(() => {
  if (directory) removeTemporaryPath(directory);
  directory = undefined;
});

function configFile(): string {
  directory = createTemporaryDirectory('cinder-design-system-url');
  return configurationPath(directory);
}

describe('design-system URL configuration', () => {
  test('lives under the user configuration directory', () => {
    expect(configurationPath('/home/someone')).toBe(
      '/home/someone/.config/corvidae/design-system.json',
    );
  });

  test('reads nothing when neither source is set', () => {
    expect(readConfiguredUrl({}, configFile())).toBeUndefined();
  });

  test('saves to and reads from the configuration file', () => {
    const path = configFile();
    saveConfiguredUrl(url, path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url });
    expect(readConfiguredUrl({}, path)).toEqual({ url, source: path });
  });

  test('prefers the environment variable over the file', () => {
    const path = configFile();
    saveConfiguredUrl(url, path);
    const other = 'https://claude.ai/code/artifact/0f9e-41aa';
    expect(readConfiguredUrl({ [URL_ENVIRONMENT_VARIABLE]: other }, path)).toEqual({
      url: other,
      source: URL_ENVIRONMENT_VARIABLE,
    });
  });

  test('rejects a value that is not an artifact link', () => {
    const path = configFile();
    expect(() => saveConfiguredUrl('https://example.com/artifact/x', path)).toThrow(
      'not a claude.ai artifact link',
    );
    expect(() =>
      readConfiguredUrl({ [URL_ENVIRONMENT_VARIABLE]: 'claude.ai/artifact/x' }, path),
    ).toThrow(URL_ENVIRONMENT_VARIABLE);
    saveConfiguredUrl(url, path);
    writeFileSync(path, '{"link": "x"}');
    expect(() => readConfiguredUrl({}, path)).toThrow('must hold');
  });
});
