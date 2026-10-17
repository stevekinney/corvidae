import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import {
  createMCP,
  createMcpElicitationHandler,
  MCP_ELICITATION_INPUT_KEY,
  MCP_PROTOCOL_VERSION,
  type CreateMCPOptions,
  type MCPServer,
} from '../src/integrations/mcp';
import { fromMcpClientTools } from '../src/integrations/mcp/oauth';
import type { ToolElicitationRequest, ToolElicitationResult } from '../src/is-tool';
import { throwingRejectionOf } from '../src/testing/promise-outcome.test-support';
import { connectInProcessClient } from './fixtures/mcp-in-process-client';

/**
 * Multi-round input on protocol revision 2026-07-28: a tool that calls
 * `context.elicit` is suspended behind an `input_required` result and the
 * retry resumes the same execution, so the tool body — and any side effect
 * before or after the question — runs once.
 */

const MODERN = { pin: MCP_PROTOCOL_VERSION } as const;

const APPROVAL_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' } },
  required: ['approved'],
};

type Ledger = { charges: number; elicitations: number; outcomes: string[]; aborted: boolean };

function createPurchaseToolbox(ledger: Ledger) {
  return createToolbox([
    createTool({
      name: 'purchase',
      description: 'asks for approval, then charges once',
      input: z.object({ amount: z.number() }),
      async execute({ amount }, context) {
        if (!context.elicit) return 'elicitation unavailable';
        context.signal?.addEventListener('abort', () => {
          ledger.aborted = true;
        });
        ledger.elicitations += 1;
        const answer = await context.elicit({
          mode: 'form',
          message: `Charge ${amount}?`,
          schema: APPROVAL_SCHEMA,
        });
        ledger.outcomes.push(answer.action);
        if (answer.action !== 'accept' || answer.content?.['approved'] !== true) {
          return { charged: false };
        }
        ledger.charges += 1;
        return { charged: true, amount };
      },
    }),
  ]);
}

function newLedger(): Ledger {
  return { charges: 0, elicitations: 0, outcomes: [], aborted: false };
}

let endpoints: MCPServer[] = [];
let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  clients = [];
  endpoints = [];
});

async function setup(
  ledger: Ledger,
  respond: (request: ToolElicitationRequest) => Promise<ToolElicitationResult>,
  options: CreateMCPOptions = {},
) {
  const mcp = await createMCP(createPurchaseToolbox(ledger), options);
  endpoints.push(mcp);
  const { client } = await connectInProcessClient(mcp, MODERN, {
    capabilities: { elicitation: {} },
  });
  client.setRequestHandler('elicitation/create', createMcpElicitationHandler(respond));
  clients.push(client);
  return { mcp, client };
}

type InputRequiredValue = {
  resultType: 'input_required';
  inputRequests: Record<string, { method: string; params: Record<string, unknown> }>;
  requestState: string;
};

/** Calls the tool in the SDK's manual multi-round mode and returns the raw first round. */
async function firstRound(client: Client): Promise<InputRequiredValue> {
  const result = await client.callTool(
    { name: 'purchase', arguments: { amount: 30 } },
    { allowInputRequired: true },
  );
  return result as unknown as InputRequiredValue;
}

/** Retries the call with explicit `inputResponses` and `requestState`, as the spec's client does. */
function retry(client: Client, requestState: string, inputResponses: Record<string, unknown>) {
  return client.callTool(
    {
      name: 'purchase',
      arguments: { amount: 30 },
      inputResponses,
      requestState,
    } as Parameters<Client['callTool']>[0],
    { allowInputRequired: true },
  );
}

const ACCEPT = { action: 'accept', content: { approved: true } };

describe('MCP input_required (2026-07-28)', () => {
  it('suspends the execution and resumes it with the answer, running the tool once', async () => {
    const ledger = newLedger();
    const requests: ToolElicitationRequest[] = [];
    const { client, mcp } = await setup(ledger, async (request) => {
      requests.push(request);
      return { action: 'accept', content: { approved: true } };
    });

    const result = await client.callTool({ name: 'purchase', arguments: { amount: 30 } });

    expect(result.structuredContent).toEqual({ charged: true, amount: 30 });
    expect(requests).toEqual([{ mode: 'form', message: 'Charge 30?', schema: APPROVAL_SCHEMA }]);
    expect(ledger).toMatchObject({ charges: 1, elicitations: 1, outcomes: ['accept'] });
    const [snapshot] = mcp.executionLifecycle.inspect();
    expect(snapshot?.state).toBe('terminal');
  });

  it('delivers a declined answer to the waiting tool', async () => {
    const ledger = newLedger();
    const { client } = await setup(ledger, async () => ({ action: 'decline' }));
    const result = await client.callTool({ name: 'purchase', arguments: { amount: 30 } });
    expect(result.structuredContent).toEqual({ charged: false });
    expect(ledger).toMatchObject({ charges: 0, elicitations: 1, outcomes: ['decline'] });
  });

  it('returns an input_required round naming the elicitation and a sealed requestState', async () => {
    const ledger = newLedger();
    const { client } = await setup(ledger, async () => ({ action: 'cancel' }));
    const round = await firstRound(client);
    expect(round.resultType).toBe('input_required');
    expect(round.inputRequests[MCP_ELICITATION_INPUT_KEY]).toEqual({
      method: 'elicitation/create',
      params: { mode: 'form', message: 'Charge 30?', requestedSchema: APPROVAL_SCHEMA },
    });
    expect(round.requestState).toBeString();
    expect(ledger.charges).toBe(0);
  });

  it('refuses a duplicate retry of an answered round without re-running the tool', async () => {
    const ledger = newLedger();
    const { client } = await setup(ledger, async () => ({ action: 'cancel' }));
    const round = await firstRound(client);
    const answers = { [MCP_ELICITATION_INPUT_KEY]: ACCEPT };

    const [first, duplicate] = await Promise.all([
      retry(client, round.requestState, answers),
      retry(client, round.requestState, answers),
    ]);
    const results = [first, duplicate];
    expect(results.filter((result) => result.isError !== true)).toHaveLength(1);
    expect(results.find((result) => result.isError === true)?.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('not run again') }),
    ]);
    expect(ledger).toMatchObject({ charges: 1, elicitations: 1 });

    const late = await retry(client, round.requestState, answers);
    expect(late.isError).toBe(true);
    expect(ledger).toMatchObject({ charges: 1, elicitations: 1 });
  });

  it('re-issues the same round when the retry carries no answer', async () => {
    const ledger = newLedger();
    const { client } = await setup(ledger, async () => ({ action: 'cancel' }));
    const round = await firstRound(client);
    const reissued = (await retry(client, round.requestState, {})) as unknown as InputRequiredValue;
    expect(reissued.resultType).toBe('input_required');
    expect(reissued.inputRequests).toEqual(round.inputRequests);

    const done = await retry(client, reissued.requestState, {
      [MCP_ELICITATION_INPUT_KEY]: ACCEPT,
    });
    expect(done.structuredContent).toEqual({ charged: true, amount: 30 });
    expect(ledger).toMatchObject({ charges: 1, elicitations: 1 });
  });

  it('rejects a tampered requestState before the tool handler runs', async () => {
    const ledger = newLedger();
    const { client } = await setup(ledger, async () => ({ action: 'cancel' }));
    const round = await firstRound(client);
    const tampered = retry(client, `${round.requestState}tampered`, {
      [MCP_ELICITATION_INPUT_KEY]: ACCEPT,
    });
    expect(await throwingRejectionOf(tampered)).toThrow('Invalid or expired requestState');
    expect(ledger.charges).toBe(0);
  });

  it('rejects an answer that does not match the requested schema inside the tool', async () => {
    const ledger = newLedger();
    const { client } = await setup(ledger, async () => ({ action: 'cancel' }));
    const round = await firstRound(client);
    const result = await retry(client, round.requestState, {
      [MCP_ELICITATION_INPUT_KEY]: { action: 'accept', content: { approved: 'yes' } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('did not match the requested schema');
    expect(ledger.charges).toBe(0);
  });

  it('expires an unanswered round, aborting the suspended execution', async () => {
    const ledger = newLedger();
    const { client, mcp } = await setup(ledger, async () => ({ action: 'cancel' }), {
      inputRounds: { ttlMs: 20 },
    });
    const round = await firstRound(client);
    await mcp.executionLifecycle.whenIdle();
    expect(ledger.aborted).toBe(true);

    const late = await retry(client, round.requestState, { [MCP_ELICITATION_INPUT_KEY]: ACCEPT });
    expect(late.isError).toBe(true);
    expect(ledger.charges).toBe(0);
  });

  it('aborts suspended executions on shutdown', async () => {
    const ledger = newLedger();
    const { client, mcp } = await setup(ledger, async () => ({ action: 'cancel' }));
    await firstRound(client);
    const report = await mcp.shutdown();
    expect(ledger.aborted).toBe(true);
    expect(report.snapshots.every((snapshot) => snapshot.state !== 'active')).toBe(true);
  });

  it('answers a remote elicitation through fromMcpClientTools (client direction)', async () => {
    const ledger = newLedger();
    const { client } = await setup(ledger, async () => ({
      action: 'accept',
      content: { approved: true },
    }));
    const [purchase] = await fromMcpClientTools(client);
    expect(await purchase?.execute({ amount: 12 })).toEqual({ charged: true, amount: 12 });
    expect(ledger.charges).toBe(1);
  });

  it('leaves context.elicit undefined for a client without the elicitation capability', async () => {
    const ledger = newLedger();
    const mcp = await createMCP(createPurchaseToolbox(ledger));
    endpoints.push(mcp);
    const { client } = await connectInProcessClient(mcp, MODERN);
    clients.push(client);
    const result = await client.callTool({ name: 'purchase', arguments: { amount: 30 } });
    expect(result.content).toEqual([{ type: 'text', text: 'elicitation unavailable' }]);
  });
});

describe('MCP elicitation on the stateless 2025-11-25 lane', () => {
  it('leaves context.elicit undefined because the lane has no server-to-client channel', async () => {
    const ledger = newLedger();
    const mcp = await createMCP(createPurchaseToolbox(ledger));
    endpoints.push(mcp);
    const { client } = await connectInProcessClient(mcp, 'legacy', {
      capabilities: { elicitation: {} },
    });
    clients.push(client);
    const result = await client.callTool({ name: 'purchase', arguments: { amount: 30 } });
    expect(result.content).toEqual([{ type: 'text', text: 'elicitation unavailable' }]);
  });
});
