/**
 * A build made inside a checkout records the checkout's real commit, so `serve` accepts it. The
 * end-to-end server and the release build both go through `buildCheckoutApplication`; a build with
 * no source records an unknown commit, which `serve` refuses. Git runs at module scope.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBuildInfo, readSourceInfo, UNKNOWN_COMMIT } from '../src/host/build-info.ts';
import { serveProblem } from '../src/host/supervisor.ts';
import { buildApplication, buildCheckoutApplication, PACKAGE_DIRECTORY } from './build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'build-checkout-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function stubGraph(directory: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'current.json'), '{}');
  return { directory, manifest: {} as never };
}
const graphs = {
  buildNative: stubGraph,
  buildPrivate: ({ outputDirectory }: { outputDirectory: string }) => stubGraph(outputDirectory),
  ensureGenerated: () => {},
};
const checkoutOutput = join(mkdtempSync(join(scratch, 'a-')), 'build');
await buildCheckoutApplication({ outdir: checkoutOutput, ...graphs });
const sourceless = join(mkdtempSync(join(scratch, 'b-')), 'build');
await buildApplication({ outdir: sourceless, ...graphs });
const checkout = readSourceInfo(PACKAGE_DIRECTORY);

describe('buildCheckoutApplication', () => {
  test('records the checkout commit, and `serve` accepts that build', () => {
    expect(checkout.commit).not.toBe(UNKNOWN_COMMIT);
    expect(readBuildInfo(checkoutOutput)).toEqual(checkout);
    expect(serveProblem(checkoutOutput)).toBeUndefined();
  });

  test('a build with no source records an unknown commit, which `serve` refuses inside a checkout', () => {
    expect(readBuildInfo(sourceless)?.commit).toBe(UNKNOWN_COMMIT);
    expect(serveProblem(sourceless)).toContain('was made from unknown');
  });
});
