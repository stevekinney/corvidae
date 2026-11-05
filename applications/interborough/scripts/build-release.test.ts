import { describe, expect, test } from 'bun:test';
import { pluginRuntimeDirectory } from '../src/host/cli.ts';
import { parseReleaseArguments } from './build-release.ts';

describe('release arguments', () => {
  test('requires a semver and output directory', () => {
    expect(parseReleaseArguments(['--version', '1.2.3', '--outdir', '/tmp/release'])).toEqual({
      version: '1.2.3',
      outdir: '/tmp/release',
    });
    expect(() => parseReleaseArguments(['--outdir', '/tmp/release'])).toThrow('--version');
    expect(() =>
      parseReleaseArguments(['--version', 'latest', '--outdir', '/tmp/release']),
    ).toThrow('semver');
  });

  test('rejects unknown arguments', () => {
    expect(() => parseReleaseArguments(['--version', '1.2.3', '--nope'])).toThrow(
      'Unknown release argument',
    );
  });

  test('derives the plugin runtime from the relocated executable', () => {
    expect(pluginRuntimeDirectory('/opt/interborough/bin/interborough')).toBe(
      '/opt/interborough/share/interborough/plugin-runtime/node_modules',
    );
  });
});
