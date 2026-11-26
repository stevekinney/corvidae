import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { throwingRejectionOf } from './helpers/promise-outcome.ts';
import { resolveNativeNode, runNodeTests } from './node-runtime.ts';

const fixture = (name: string) =>
  new URL(`./node-runtime-fixtures/${name}`, import.meta.url).pathname;

const nativeVersion = process.env['CORVIDAE_NODE_BINARY'];
const passing = await runNodeTests([fixture('passing.ts')], { shim: true });
const failing = await runNodeTests([fixture('failing.ts')], { shim: true });
const bundled = await runNodeTests([fixture('bundled.ts')], { bundle: true, shim: true });

const fakeNodeRefusal = await (async () => {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-node-runtime-fake-'));
  const binary = join(directory, 'node');
  const original = process.env['CORVIDAE_NODE_BINARY'];
  try {
    writeFileSync(
      binary,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v20.0.0; else echo node; fi\n',
    );
    chmodSync(binary, 0o755);
    process.env['CORVIDAE_NODE_BINARY'] = binary;
    return await throwingRejectionOf(resolveNativeNode());
  } finally {
    if (original === undefined) delete process.env['CORVIDAE_NODE_BINARY'];
    else process.env['CORVIDAE_NODE_BINARY'] = original;
    rmSync(directory, { recursive: true, force: true });
  }
})();

describe('runNodeTests', () => {
  test('runs two bun:test cases through the Node shim', () => {
    expect(passing.exitCode).toBe(0);
    expect(passing.passCount).toBe(2);
    expect(passing.failCount).toBe(0);
  });

  test('returns the Node version selected by CORVIDAE_NODE_BINARY', () => {
    if (nativeVersion !== undefined && nativeVersion !== '') {
      expect(passing.version).toBe(
        Bun.spawnSync([nativeVersion, '--version']).stdout.toString().trim(),
      );
    }
  });

  test('returns a nonzero exit and failure count', () => {
    expect(failing.exitCode).not.toBe(0);
    expect(failing.failCount).toBe(1);
  });

  test('bundles an extensionless sibling import', () => {
    expect(bundled.exitCode).toBe(0);
    expect(bundled.passCount).toBe(1);
  });

  test('refuses a fake Node 20 binary', () => {
    expect(fakeNodeRefusal).toThrow('v20.0.0');
  });
});
