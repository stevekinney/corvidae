/**
 * A build made inside a checkout records the checkout's real commit, so `serve` accepts it. The
 * end-to-end server and the release build both go through `buildCheckoutApplication`; a build with
 * no source records an unknown commit, which `serve` refuses. Git runs at module scope.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBuildInfo, readSourceInfo, UNKNOWN_COMMIT } from '../src/host/build-info.ts';
import { serveProblem } from '../src/host/supervisor.ts';
import { buildApplication, buildCheckoutApplication, PACKAGE_DIRECTORY } from './build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'build-checkout-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A bundler that writes only a page, as the bundler would write a build. */
const bundle = async (configuration: Bun.BuildConfig): Promise<Bun.BuildOutput> => {
  const outdir = configuration.outdir ?? '';
  writeFileSync(join(outdir, 'index.html'), 'page');
  return {
    success: true,
    outputs: [{ path: join(outdir, 'index.html') }],
    logs: [],
    metafile: { inputs: {}, outputs: {} },
  } as unknown as Bun.BuildOutput;
};

const checkoutOutput = join(mkdtempSync(join(scratch, 'a-')), 'build');
await buildCheckoutApplication({ outdir: checkoutOutput, bundle });
const sourceless = join(mkdtempSync(join(scratch, 'b-')), 'build');
await buildApplication({ outdir: sourceless, bundle });
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
