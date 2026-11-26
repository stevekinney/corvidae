import { join } from 'node:path';

import { resolveNativeNode, runNodeTests } from '@lostgradient/testing/node-runtime';
import { describe, expect, test } from 'bun:test';

import { hostContract, type ContractHostFactory } from './host-contract.ts';

const here = import.meta.dir;
const node = await resolveNativeNode();
const result = await runNodeTests([join(here, 'node-host.test.ts')], { bundle: true });

const serveWithBun: ContractHostFactory = (options) =>
  Bun.serve(options as Parameters<typeof Bun.serve>[0]) as ReturnType<ContractHostFactory>;

hostContract('Bun.serve', serveWithBun);

describe('Node Host on native Node', () => {
  test('runs the shared host contract under Node 22+', () => {
    expect(result.version).toMatch(/^v2[2-9]\./u);
    expect(result.exitCode, `${node}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.failCount).toBe(0);
    expect(result.passCount).toBeGreaterThan(0);
  });
});
