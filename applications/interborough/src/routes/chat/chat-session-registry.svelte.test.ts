/**
 * COR-2439 AC7, AC8 (COR-2293 B2): a chat route's session is retained when the route is released
 * and reused when it is reacquired, so a route return opens no second attach over the same run.
 * The registry is bounded (four retained sessions), fenced by generation, keeps a released session
 * only while it has live work, and disposes it on an event: its work ending, an error, eviction,
 * or the registry's own disposal.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import type { Fetcher } from '../../lib/bureau-client.ts';
import {
  ChatSessionRegistry,
  openChatSession,
  type ChatSessionHost,
} from './chat-session-registry.svelte.ts';
import { releaseFromTeardown } from './chat-session-registry.test-support.svelte.ts';
import { AG_UI_PATH } from './run-wiring.ts';

const registries: ChatSessionRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

const urlOf = (input: Parameters<Fetcher>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const sse = (events: readonly unknown[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const started = { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' };
const finished = { type: 'RUN_FINISHED', threadId: 'thread', runId: 'run' };
const reply = (id: string) => [
  { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: 'Done.' },
  { type: 'TEXT_MESSAGE_END', messageId: id },
];
const idle = () => sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);

/** A Bureau whose agent POSTs wait until the test answers them, counting what was asked. */
function bureau(options: { readonly attach?: Promise<Response> } = {}) {
  const attaches: string[] = [];
  const posts: string[] = [];
  const pending: Array<PromiseWithResolvers<Response>> = [];
  const fetch: Fetcher = async (input, init) => {
    const url = urlOf(input);
    if (url === `${AG_UI_PATH}/threads/thread/run`) {
      attaches.push(url);
      return options.attach ?? idle();
    }
    if (url === `${AG_UI_PATH}/threads/thread/messages`) {
      return Response.json({ threadId: 'thread', messages: [] });
    }
    if (init?.method === 'POST' && url === `${AG_UI_PATH}/agents/assistant/run`) {
      posts.push(url);
      const answer = Promise.withResolvers<Response>();
      pending.push(answer);
      return answer.promise;
    }
    return new Response('', { status: 404 });
  };
  return { fetch, attaches, posts, pending };
}

function host(overrides: Partial<ChatSessionHost> = {}): ChatSessionHost {
  return { agentName: () => 'assistant', ...overrides };
}

function registry(capacity?: number): ChatSessionRegistry {
  const made = new ChatSessionRegistry(capacity === undefined ? {} : { capacity });
  registries.push(made);
  return made;
}

describe('the retained-route session registry (COR-2293 B2)', () => {
  test('AC7: releasing then reacquiring a retained route makes one attach GET and two agent POSTs', async () => {
    const server = bureau();
    const sessions = registry();

    const first = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    expect(first.reacquired).toBe(false);
    await first.attached;
    const opening = first.session.send('First');
    await waitUntil(() => server.posts.length === 1, { message: 'the opener was posted' });

    // The route is left while the opener's run goes on, and comes back.
    first.release();
    expect(sessions.has('thread')).toBe(true);
    const second = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    expect(second.reacquired).toBe(true);
    expect(second.session).toBe(first.session);
    await second.attached;

    server.pending[0]!.resolve(sse([started, ...reply('reply-1'), finished]));
    await opening;
    const following = second.session.send('Second');
    await waitUntil(() => server.posts.length === 2, { message: 'the second message was posted' });
    server.pending[1]!.resolve(sse([started, ...reply('reply-2'), finished]));
    await following;

    expect(server.attaches).toHaveLength(1);
    expect(server.posts).toHaveLength(2);
  });

  test('AC8: a public opener’s admission is classified after a pending attach, on a reacquired route too', async () => {
    const attach = Promise.withResolvers<Response>();
    const server = bureau({ attach: attach.promise });
    const sessions = registry();

    const first = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    await waitUntil(() => server.attaches.length === 1, { message: 'the attach was asked for' });
    // The route is left and comes back while the attach is still pending.
    first.release();
    const second = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    expect(second.reacquired).toBe(true);

    const opening = second.session.send('Hello');
    // Nothing is admitted before the attach says whether a run is going.
    await Promise.resolve();
    expect(server.posts).toEqual([]);

    // The attach finds no run, so the message is an ordinary opener.
    attach.resolve(idle());
    await waitUntil(() => server.posts.length === 1, { message: 'the opener was posted' });
    server.pending[0]!.resolve(sse([started, ...reply('reply-1'), finished]));
    await opening;
    expect(server.attaches).toHaveLength(1);
    expect(server.posts).toHaveLength(1);
  });

  test('a released session with no live work is disposed at once, and the next visit attaches again', async () => {
    const server = bureau();
    const sessions = registry();
    const first = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    await first.attached;
    first.release();
    expect(sessions.has('thread')).toBe(false);

    const second = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    expect(second.reacquired).toBe(false);
    await second.attached;
    expect(server.attaches).toHaveLength(2);
  });

  test('a retained session is disposed when its live work ends, an event and no timer', async () => {
    const server = bureau();
    const sessions = registry();
    const first = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    await first.attached;
    const opening = first.session.send('First');
    await waitUntil(() => server.posts.length === 1, { message: 'the opener was posted' });
    first.release();
    expect(sessions.has('thread')).toBe(true);

    server.pending[0]!.resolve(sse([started, ...reply('reply-1'), finished]));
    await opening;
    await waitUntil(() => !sessions.has('thread'), { message: 'the idle session was disposed' });
  });

  test('a retained session whose run errors is released', async () => {
    const server = bureau();
    const sessions = registry();
    const first = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    await first.attached;
    const opening = first.session.send('First').catch(() => undefined);
    await waitUntil(() => server.posts.length === 1, { message: 'the opener was posted' });
    first.release();

    server.pending[0]!.reject(new TypeError('network down'));
    await opening;
    await waitUntil(() => !sessions.has('thread'), { message: 'the failed session was disposed' });
  });

  test('a retained session whose route never comes back is evicted past four, oldest first', async () => {
    const sessions = registry(4);
    const held: string[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const server = bureau();
      const fetch: Fetcher = async (input, init) => {
        const url = urlOf(input).replace(`/threads/${name}/`, '/threads/thread/');
        return server.fetch(url, init);
      };
      const opened = openChatSession(sessions, { sessionId: name, fetch, unopened: true }, host());
      void opened.session.send('Keep going').catch(() => undefined);
      await waitUntil(() => server.posts.length === 1, { message: `${name} was posted` });
      opened.release();
      held.push(name);
    }
    expect(sessions.retained).toBe(4);
    expect(sessions.has('a')).toBe(false);
    for (const name of ['b', 'c', 'd', 'e']) expect(sessions.has(name)).toBe(true);
  });

  test('a page that releases from its teardown keeps a live session retained', async () => {
    const server = bureau();
    const sessions = registry();
    const opened = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    await opened.attached;
    const opening = opened.session.send('First');
    await waitUntil(() => server.posts.length === 1, { message: 'the opener was posted' });
    // A page's onMount cleanup runs inside an effect's teardown, where no effect may be created.
    const destroy = releaseFromTeardown(() => opened.release());
    expect(() => destroy()).not.toThrow();
    expect(sessions.retained).toBe(1);

    server.pending[0]!.resolve(sse([started, ...reply('reply-1'), finished]));
    await opening;
    await waitUntil(() => !sessions.has('thread'), { message: 'the idle session was disposed' });
  });

  test('disposing the registry disposes every session it holds', async () => {
    const server = bureau();
    const sessions = registry();
    const opened = openChatSession(sessions, { sessionId: 'thread', fetch: server.fetch }, host());
    await opened.attached;
    void opened.session.send('First').catch(() => undefined);
    await waitUntil(() => server.posts.length === 1, { message: 'the opener was posted' });
    opened.release();

    sessions.dispose();
    expect(sessions.has('thread')).toBe(false);
    expect(sessions.retained).toBe(0);
  });

  test('a stale release cannot release a newer holder, and callbacks go to the current holder', async () => {
    const server = bureau();
    const sessions = registry();
    const started1: string[] = [];
    const first = openChatSession(
      sessions,
      { sessionId: 'thread', fetch: server.fetch },
      host({ onRunStarted: () => started1.push('first') }),
    );
    await first.attached;
    const second = openChatSession(
      sessions,
      { sessionId: 'thread', fetch: server.fetch },
      host({ onRunStarted: () => started1.push('second') }),
    );
    expect(second.reacquired).toBe(true);

    // The first page's late cleanup is fenced off: the second page still holds the session.
    first.release();
    expect(sessions.has('thread')).toBe(true);
    expect(sessions.retained).toBe(0);

    const opening = second.session.send('Hello');
    await waitUntil(() => server.posts.length === 1, { message: 'the opener was posted' });
    server.pending[0]!.resolve(sse([started, ...reply('reply-1'), finished]));
    await opening;
    expect(started1).toEqual(['second']);

    second.release();
    expect(sessions.has('thread')).toBe(false);
  });
});
