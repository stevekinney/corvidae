import { describe, expect, test } from 'bun:test';

import type { Artifact } from '@a2a-js/sdk';

import { A2APeerError } from './peer-client-types.ts';
import { createScriptedPeer, type ScriptedPeerOptions } from './peer-client.test-support.ts';
import { createA2APeerClient } from './peer-client.ts';
import { foldArtifactUpdate, mapArtifact, MAX_PEER_ARTIFACT_PARTS } from './peer-parts.ts';

const immediate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function connect(
  peerOptions: ScriptedPeerOptions = {},
  clientOptions: Partial<Parameters<typeof createA2APeerClient>[0]> = {},
) {
  const peer = createScriptedPeer(peerOptions);
  const client = createA2APeerClient({
    url: peer.url,
    fetch: peer.fetch,
    sleep: immediate,
    retryBaseDelayMs: 1,
    ...clientOptions,
  });
  return { peer, client };
}

const polling: ScriptedPeerOptions['card'] = (card) => {
  if (card.capabilities !== undefined) card.capabilities.streaming = false;
  return card;
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof A2APeerError) return error.code;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

function part(content: NonNullable<Artifact['parts'][number]['content']>, mediaType = '') {
  return { content, metadata: undefined, filename: '', mediaType };
}

function artifact(parts: Artifact['parts'], artifactId = 'a'): Artifact {
  return { artifactId, name: '', description: '', parts, metadata: undefined, extensions: [] };
}

describe('A2A peer client review round 3', () => {
  test('a stream that never emits its first event fails with a timeout', async () => {
    const { client } = connect(
      {
        intercept: (_request, method) =>
          method === 'SendStreamingMessage'
            ? new Response(new ReadableStream({ start() {} }), {
                headers: { 'content-type': 'text/event-stream' },
              })
            : undefined,
      },
      { taskTimeoutMs: 30, attempts: 1 },
    );
    expect(await codeOf(client.send({ text: 'hi' }))).toBe('timeout');
  });

  test('send uses the request as it was when send was called', async () => {
    const bodies: string[] = [];
    const { client } = connect({
      intercept: async (request, method) => {
        if (method === 'card') await new Promise((resolve) => setTimeout(resolve, 20));
        else bodies.push(await request.clone().text());
        return undefined;
      },
    });
    const request = { text: 'original' };
    const pending = client.send(request);
    request.text = 'changed';
    await (await pending).result();
    expect(bodies.join('')).toContain('original');
    expect(bodies.join('')).not.toContain('changed');
  });

  test('card() hands out a frozen copy that cannot change later requests', async () => {
    const { client } = connect();
    const card = await client.card();
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.activeExtensions)).toBe(true);
    expect(await client.card()).not.toBe(card);
    expect(() => ((card as { streaming: boolean }).streaming = false)).toThrow();
    expect((await client.card()).streaming).toBe(true);
  });

  test('a failure while following the task drops the cached card', async () => {
    let cardReads = 0;
    const { client } = connect(
      {
        card: polling,
        intercept: async (request, method) => {
          if (method === 'card') cardReads += 1;
          if (method !== 'GetTask') return undefined;
          const body = (await request.clone().json()) as { id: number };
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32009, message: 'Version not supported' },
          });
        },
      },
      { attempts: 1 },
    );
    const task = await client.send({ text: 'slow' });
    expect(await codeOf(task.result())).toBe('version-not-supported');
    const before = cardReads;
    await client.send({ text: 'again' }).catch(() => undefined);
    expect(cardReads).toBeGreaterThan(before);
  });

  test('the first poll waits no longer than retryMaxDelayMs', async () => {
    const sleeps: number[] = [];
    const { client } = connect(
      { card: polling },
      {
        pollIntervalMs: 10_000,
        retryMaxDelayMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    await (await client.send({ text: 'hi' })).result();
    expect(Math.max(...sleeps, 0)).toBeLessThanOrEqual(50);
  });
});

describe('peer artifact bounds', () => {
  test('keeps at most MAX_PEER_ARTIFACT_PARTS parts however many are sent', () => {
    const many = Array.from({ length: MAX_PEER_ARTIFACT_PARTS + 50 }, () =>
      part({ $case: 'url', value: 'https://x.test/a' }),
    );
    expect(mapArtifact(artifact(many), 1_000_000).parts).toHaveLength(MAX_PEER_ARTIFACT_PARTS);
    const folded = foldArtifactUpdate(
      [mapArtifact(artifact(many), 1_000_000)],
      artifact(many),
      true,
      1_000_000,
    );
    expect(folded[0]?.parts).toHaveLength(MAX_PEER_ARTIFACT_PARTS);
  });

  test('counts reference strings toward the limit and drops an oversized one', () => {
    const mapped = mapArtifact(
      artifact([part({ $case: 'url', value: 'https://x.test/' + 'a'.repeat(500) })]),
      100,
    );
    expect(mapped.parts[0]).toMatchObject({ kind: 'omitted', reason: 'too-large' });
  });

  test('drops placeholder strings that exceed the budget', () => {
    const mapped = mapArtifact(
      artifact([part({ $case: 'raw', value: Buffer.alloc(1) }, 'm'.repeat(500))]),
      100,
    );
    expect(mapped.parts[0]).toMatchObject({ kind: 'omitted', mediaType: '' });
  });

  test('spends the budget across appended chunks of references', () => {
    const chunk = artifact([part({ $case: 'url', value: 'https://x.test/' + 'a'.repeat(40) })]);
    let folded = foldArtifactUpdate([], chunk, false, 200);
    for (let index = 0; index < 20; index++) folded = foldArtifactUpdate(folded, chunk, true, 200);
    const kept = folded[0]?.parts.filter((entry) => entry.kind === 'reference') ?? [];
    expect(kept.length).toBeLessThan(10);
  });
});
