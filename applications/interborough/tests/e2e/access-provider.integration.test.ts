import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost } from '../../src/host/host.ts';
import { fakeProvider, writeProviderHome } from '../../src/host/stub-provider.ts';
import { initializeWorkspaceHome } from '../../src/host/workspace-home.test-support.ts';
import {
  createAccessProviderResolver,
  REVIEW_REMEMBER_MARKER,
  REVIEW_REMEMBER_TOOL,
  reviewRememberTool,
} from './access-provider.ts';

test('the file-agent review fixture exposes a real remembered approval', async () => {
  const home = await mkdtemp(join(tmpdir(), 'review-remember-'));
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    await initializeWorkspaceHome(home);
    await writeProviderHome(home);
    host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      extraTools: { [REVIEW_REMEMBER_TOOL]: reviewRememberTool },
      resolveProviderGenerate: createAccessProviderResolver(fakeProvider('fallback').resolver),
    });
    const created = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'bureau.agents.definitions.create',
        params: {
          id: 'review-remember',
          definition: {
            name: 'Review remember',
            description: 'A fixture agent',
            model: 'anthropic/sonnet',
            tools: [REVIEW_REMEMBER_TOOL],
            instructions: 'Record the fixture value.',
          },
        },
      }),
    });
    expect(await created.json()).toMatchObject({ result: { id: 'review-remember' } });
    const task = await host.bureau.tasks.start('review-remember', REVIEW_REMEMBER_MARKER);
    await host.bureau.tasks.wait(task.id);
    const review = host.bureau.reviews.list().find((item) => item.runId === task.id);
    if (review?.kind !== 'tool-approval') throw new Error('Expected a pending tool approval');
    expect(await host.bureau.reviews.mayRemember(review)).toBe(true);
    const decision = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'bureau.reviews.resolve',
        params: { id: review.id, round: review.round, decision: 'approve', remember: true },
      }),
    });
    expect(await decision.json()).toMatchObject({
      result: { receipt: 'applied', remembered: true },
    });
  } finally {
    await host?.close();
    await rm(home, { recursive: true, force: true });
  }
});
