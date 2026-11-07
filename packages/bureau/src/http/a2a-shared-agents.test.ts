/**
 * COR-2019 — the `a2a.agents` setting: which agents answer over A2A, from Settings. An agent the
 * record names follows its entry, and one it leaves out follows its own definition; the change is
 * live, and the deployment's directory card lists whoever is shared.
 */
import { describe, expect, it } from 'bun:test';

import { type OpenedBureau, rpc } from './management/management-fixtures.test-support.ts';
import {
  answering,
  type Json,
  message,
  PUBLIC_URL,
  send,
  withA2A,
} from './a2a-mount.test-support.ts';

const CARD = (name: string) => `http://localhost/a2a/${name}/.well-known/agent-card.json`;
const DIRECTORY = 'http://localhost/a2a/.well-known/agent-card.json';

/** Sets the `a2a.agents` record, as Settings does. */
async function share(opened: OpenedBureau, record: Record<string, boolean> | null): Promise<void> {
  const { revision } = await opened.bureau.settings.get();
  const result = await opened.bureau.settings.update(
    { 'a2a.agents': record },
    { expectedRevision: revision },
  );
  expect(result.outcome).toBe('applied');
}

async function cardStatus(opened: OpenedBureau, name: string): Promise<number> {
  const response = await opened.handler(new Request(CARD(name)));
  return response.status;
}

async function sendStatus(opened: OpenedBureau, name: string): Promise<number> {
  const sent = await send(opened, name, { message: message('hi') });
  return sent.status;
}

async function directory(opened: OpenedBureau): Promise<Json> {
  const response = await opened.handler(new Request(DIRECTORY));
  expect(response.status).toBe(200);
  return response.json();
}

describe('the a2a.agents setting', () => {
  it('shares an agent its definition leaves out, and refuses it again when withdrawn', async () => {
    await withA2A(
      { asker: answering('done'), hidden: answering('no') },
      async (opened) => {
        expect(await cardStatus(opened, 'hidden')).toBe(404);
        expect(await sendStatus(opened, 'hidden')).toBe(404);

        await share(opened, { hidden: true });
        expect(await cardStatus(opened, 'hidden')).toBe(200);
        expect(await sendStatus(opened, 'hidden')).toBe(200);

        // The task it already started keeps a tombstone, which serves that task and never a card or
        // a new one.
        await share(opened, { hidden: false });
        expect(await cardStatus(opened, 'hidden')).toBe(404);
        const refused = await send(opened, 'hidden', { message: message('again') });
        expect(refused.body.error).toBeDefined();
        expect(refused.body.result).toBeUndefined();
      },
      { a2aAgents: ['asker'] },
    );
  });

  it('withdraws an agent its definition shares, and leaves the agents it does not name alone', async () => {
    await withA2A({ asker: answering('done'), writer: answering('ok') }, async (opened) => {
      await share(opened, { asker: false });
      expect(await cardStatus(opened, 'asker')).toBe(404);
      expect(await cardStatus(opened, 'writer')).toBe(200);
      // Clearing the record puts the definitions back in charge.
      await share(opened, null);
      expect(await cardStatus(opened, 'asker')).toBe(200);
    });
  });

  it('is what bureau.agents.list reports as a2a', async () => {
    await withA2A(
      { asker: answering('done'), hidden: answering('no') },
      async (opened) => {
        const listed = async () => {
          const answered = await rpc(opened.handler, 'bureau.agents.list', {}, 'agents-reader-key');
          const agents = (answered.result?.['agents'] ?? []) as { name: string; a2a: boolean }[];
          return Object.fromEntries(
            agents
              .filter((agent) => agent.name !== 'default')
              .map((agent) => [agent.name, agent.a2a]),
          );
        };
        expect(await listed()).toEqual({ asker: true, hidden: false });
        await share(opened, { asker: false, hidden: true });
        expect(await listed()).toEqual({ asker: false, hidden: true });
      },
      { a2aAgents: ['asker'] },
    );
  });
});

describe('the A2A directory card', () => {
  it('lists the shared agents, without credentials, and follows the setting', async () => {
    await withA2A(
      { asker: answering('done'), hidden: answering('no') },
      async (opened) => {
        const before = await directory(opened);
        expect(before.agents).toEqual([
          {
            name: 'asker',
            displayName: 'asker',
            description: 'The asker agent',
            url: `${PUBLIC_URL}/a2a/asker`,
            cardUrl: `${PUBLIC_URL}/a2a/asker/.well-known/agent-card.json`,
          },
        ]);
        expect(before.supportedInterfaces).toHaveLength(1);
        expect(before.skills.map((skill: Json) => skill.id)).toEqual(['asker']);

        await share(opened, { hidden: true });
        const after = await directory(opened);
        expect(after.agents.map((agent: Json) => agent.name).toSorted()).toEqual([
          'asker',
          'hidden',
        ]);
        const again = await opened.handler(new Request(DIRECTORY));
        expect(again.headers.get('cache-control')).toBe('no-cache');
      },
      { a2aAgents: ['asker'] },
    );
  });

  it('answers only a read, and is not an agent’s interface', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const posted = await opened.handler(new Request(DIRECTORY, { method: 'POST', body: '{}' }));
      expect(posted.status).toBe(404);
      const jwks = await opened.handler(
        new Request('http://localhost/a2a/.well-known/jwks.json', {
          headers: { 'X-API-Key': 'alice-key' },
        }),
      );
      expect(jwks.status).toBe(404);
    });
  });
});
