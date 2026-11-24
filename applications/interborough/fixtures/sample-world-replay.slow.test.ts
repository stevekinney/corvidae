import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seedSampleWorld } from './sample-world-seed.ts';

test('replaying a seed preserves its stable manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-replay-'));
  const home = join(root, 'home');
  const ownership = { root, owner: root };
  async function manifest() {
    const { host } = await seedSampleWorld(home, { ownership });
    try {
      const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.contexts.list',
          params: { origin: 'chat' },
        }),
      });
      const body = (await response.json()) as {
        result: { contexts: Array<{ id: string; agentName: string; createdAt: string }> };
      };
      const contexts = body.result.contexts;
      const roles = await Promise.all(
        contexts.map(async (context) => {
          const session = await host.bureau.contexts.get(context.id);
          return (session?.conversationHistory.ids ?? []).map(
            (id) => session?.conversationHistory.messages[id]?.role,
          );
        }),
      );
      return {
        count: contexts.length,
        chats: contexts.map(({ id, agentName, createdAt }, index) => ({
          id,
          agentName,
          date: createdAt.slice(0, 16),
          roles: roles[index],
        })),
      };
    } finally {
      await host.close();
    }
  }
  try {
    const first = await manifest();
    expect(first.count).toBe(6);
    expect(await manifest()).toEqual(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
