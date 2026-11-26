/**
 * Pins what Bureau's handler puts on the wire: its three documents in each authentication mode,
 * and two JSON-RPC error bodies. When an operation legitimately changes, regenerate with the
 * update command.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VERSION } from '@lostgradient/weft/testing';

import { buildBureau } from './bureau-handler-fixtures.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import {
  assertGoldenDirectory,
  formatGoldenJson,
  GOLDEN_VERSION,
  listGoldenDirectory,
} from './golden-files.test-support.ts';
import {
  buildBureauWireGolden,
  BUREAU_WIRE_GOLDEN_DIRECTORY,
  writeBureauWireGolden,
} from './wire-golden.test-support.ts';

const UPDATE_COMMAND = '(cd packages/bureau && bun scripts/update-wire-golden.ts)';
const FILES = [
  'authenticated.asyncapi.json',
  'authenticated.openapi.json',
  'authenticated.openrpc.json',
  'error-invalid-params.json',
  'error-method-not-found.json',
  'local.asyncapi.json',
  'local.openapi.json',
  'local.openrpc.json',
];
const DOCUMENTS = FILES.filter((name) => !name.startsWith('error-'));

describe('Bureau wire goldens', () => {
  it('match what Bureau serves, byte for byte, and hold no other file', async () => {
    await assertGoldenDirectory(
      BUREAU_WIRE_GOLDEN_DIRECTORY,
      await buildBureauWireGolden(),
      UPDATE_COMMAND,
    );
  });

  it('holds exactly the eight golden files', async () => {
    expect(await listGoldenDirectory(BUREAU_WIRE_GOLDEN_DIRECTORY)).toEqual(FILES);
  });

  it('writes sorted keys, two-space indentation and a trailing newline', async () => {
    for (const name of FILES) {
      const text = await Bun.file(join(BUREAU_WIRE_GOLDEN_DIRECTORY, name)).text();
      expect(text, name).toBe(formatGoldenJson(JSON.parse(text)));
    }
  });

  it('masks the version of each document', async () => {
    for (const name of DOCUMENTS) {
      const document = JSON.parse(
        await Bun.file(join(BUREAU_WIRE_GOLDEN_DIRECTORY, name)).text(),
      ) as { info: { version: string } };
      expect(document.info.version, name).toBe(GOLDEN_VERSION);
    }
  });

  it("titles each document Bureau and versions it at Weft's version, which the goldens mask", async () => {
    const bureau = await buildBureau();
    try {
      const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });
      for (const path of ['/openapi.json', '/openrpc.json', '/asyncapi.json']) {
        const response = await handler(new Request(`http://localhost${path}`));
        const document = (await response.json()) as {
          info: { title: string; version: string };
        };
        expect(document.info.title, path).toBe('Bureau');
        expect(document.info.version, path).toBe(VERSION);
      }
    } finally {
      await bureau.dispose();
    }
  });

  describe('the update function', () => {
    let directory: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'bureau-wire-golden-'));
    });
    afterEach(async () => {
      await rm(directory, { force: true, recursive: true });
    });

    it('rewrites a directory to the goldens and removes a stray file', async () => {
      await Bun.write(join(directory, 'stray.json'), '{}\n');
      await writeBureauWireGolden(directory);
      expect(await listGoldenDirectory(directory)).toEqual(FILES);
    });
  });
});
