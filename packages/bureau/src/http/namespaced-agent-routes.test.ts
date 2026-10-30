/**
 * COR-1871 — an agent whose id is `plugin:name` round-trips through every HTTP route that takes an
 * agent id: the id is percent-encoded into the path and decoded back to the same agent.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';

import { openHarness, runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream, typesOf } from './ag-ui-stream.test-support.ts';
import { answering, message, PUBLIC_URL, send, withA2A } from './a2a-mount.test-support.ts';

const ID = 'linear:triager';
const ENCODED = encodeURIComponent(ID);

describe('an agent named plugin:name', () => {
  it('starts a run over AG-UI at its percent-encoded path', async () => {
    const harness = await openHarness({
      script: [{ kind: 'respond', response: { content: 'triaged', toolCalls: [] } }],
      otherAgents: [ID],
    });
    try {
      const response = await harness.handler(startRequest(runAgentInput(), {}, ENCODED));
      expect(response.status).toBe(200);
      const frames = await readAgUiStream(response);
      expect(typesOf(frames)[0]).toBe(EventType.RUN_STARTED);
      expect(typesOf(frames).at(-1)).toBe(EventType.RUN_FINISHED);
    } finally {
      await harness.dispose();
    }
  });

  it('serves its A2A card, JWKS discovery and interface at its percent-encoded path', async () => {
    await withA2A({ [ID]: answering('triaged') }, async (opened) => {
      const card = await opened.handler(
        new Request(`http://localhost/a2a/${ENCODED}/.well-known/agent-card.json`),
      );
      expect(card.status).toBe(200);
      const body = (await card.json()) as {
        name: string;
        supportedInterfaces: { url: string }[];
      };
      expect(body.name).toBe(ID);
      expect(body.supportedInterfaces[0]?.url).toBe(`${PUBLIC_URL}/a2a/${ENCODED}`);

      const sent = await send(opened, ENCODED, { message: message('please triage') });
      expect(sent.status).toBe(200);
      expect(sent.body.error).toBeUndefined();
    });
  });
});
