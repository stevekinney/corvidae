import { describe, expect, it } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { MemoryStorage } from '../../storage/memory.ts';
import { StreamChunkEvent } from '../events/fleet-state-events.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';

const SECRET_BODY = 'chunk-body-that-must-not-leave-the-engine';

describe('stream:chunk on the Engine', () => {
  it('announces each stored chunk of a non-token key by key and sequence, never by body', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const seen: StreamChunkEvent[] = [];
    engine.addEventListener(StreamChunkEvent.type, (event) => {
      seen.push(event);
    });
    engine.register(
      workflow({ name: 'progress-stream' }).execute(async function* (ctx) {
        yield* ctx.stream('progress', async function* () {
          yield SECRET_BODY;
          yield { step: 2 };
        });
        yield* ctx.stream('tokens', async function* () {
          yield 'token';
        });
        return 'done';
      }),
    );

    const handle = await engine.start('progress-stream', {});
    await handle.result();
    await waitUntil(() => seen.length >= 2, { message: 'both progress chunks announced' });

    expect(seen.map((event) => [event.workflowId, event.key, event.sequence])).toEqual([
      [handle.id, 'progress', 0],
      [handle.id, 'progress', 1],
    ]);
    for (const event of seen) {
      expect(Object.keys(event).toSorted()).toEqual(['isTrusted', 'key', 'sequence', 'workflowId']);
      expect(JSON.stringify(event)).not.toContain(SECRET_BODY);
    }
  });

  it('does not announce a chunk of the tokens key, which already reaches subscribers through the feed', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const keys: string[] = [];
    engine.addEventListener(StreamChunkEvent.type, (event) => {
      keys.push(event.key);
    });
    engine.register(
      workflow({ name: 'token-only-stream' }).execute(async function* (ctx) {
        yield* ctx.stream('tokens', async function* () {
          yield 'a';
          yield 'b';
        });
        return 'done';
      }),
    );

    const handle = await engine.start('token-only-stream', {});
    await handle.result();

    expect(keys).toEqual([]);
  });
});
