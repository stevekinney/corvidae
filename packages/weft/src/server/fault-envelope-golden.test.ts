/**
 * Pins Weft's fault envelopes: every fault code's REST response and JSON-RPC error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FAULT_CODE_TO_FAILURE_CATEGORY } from '../core/fault-code.ts';
import {
  buildFaultEnvelopes,
  FAULT_ENVELOPE_GOLDEN_DIRECTORY,
  GOLDEN_FAULTS,
  writeFaultEnvelopeGolden,
} from './fault-envelope-golden.test-support.ts';
import { assertGoldenDirectory, formatGoldenJson } from './golden-files.test-support.ts';

const UPDATE_COMMAND = '(cd packages/weft && bun scripts/update-wire-golden.ts)';

async function expectedFiles() {
  return { 'fault-envelopes.json': formatGoldenJson(await buildFaultEnvelopes()) };
}

describe('Weft fault envelope golden', () => {
  it('has one literal fault for each of the fault codes, keyed by its own code', () => {
    expect(Object.keys(GOLDEN_FAULTS).toSorted()).toEqual(
      Object.keys(FAULT_CODE_TO_FAILURE_CATEGORY).toSorted(),
    );
    for (const [key, fault] of Object.entries(GOLDEN_FAULTS)) expect<string>(fault.code).toBe(key);
  });

  it('matches what the mappers build, byte for byte, and holds no other file', async () => {
    await assertGoldenDirectory(
      FAULT_ENVELOPE_GOLDEN_DIRECTORY,
      await expectedFiles(),
      UPDATE_COMMAND,
    );
    expect(await readdir(FAULT_ENVELOPE_GOLDEN_DIRECTORY)).toEqual(['fault-envelopes.json']);
  });

  it('writes sorted keys, two-space indentation and a trailing newline', async () => {
    const text = await Bun.file(
      join(FAULT_ENVELOPE_GOLDEN_DIRECTORY, 'fault-envelopes.json'),
    ).text();
    expect(text).toBe(formatGoldenJson(JSON.parse(text)));
  });

  describe('the update function', () => {
    let directory: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'weft-fault-golden-'));
    });
    afterEach(async () => {
      await rm(directory, { force: true, recursive: true });
    });

    it('rewrites a directory to the golden and removes a stray file', async () => {
      await Bun.write(join(directory, 'stray.json'), '{}\n');
      await writeFaultEnvelopeGolden(directory);
      expect(await readdir(directory)).toEqual(['fault-envelopes.json']);
      await assertGoldenDirectory(directory, await expectedFiles(), UPDATE_COMMAND);
    });
  });
});
