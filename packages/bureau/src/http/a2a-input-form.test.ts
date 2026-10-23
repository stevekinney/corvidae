/**
 * COR-1487 — an `INPUT_REQUIRED` task whose human wait carries an input schema is projected with an
 * A2UI form, and the form's submission is validated against the schema before the wait is released.
 *
 * The schema is configured on the Bureau (`humanInput: { inputSchemas }`, COR-1674), so the park
 * carries it from the real tool with nothing injected; the answer then travels the real path: the
 * A2A continuation, `bureau.tasks.respond`, `resolveReview`, and the engine's signal.
 */
import { Message, type Task, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  type HumanInputSchema,
} from '@lostgradient/operative';
import { MemoryStorage, principalFromApiKey, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createCommandLedger } from '../command-ledger.ts';
import { waitForCondition } from '../test';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import type { TaskView } from '../task-registry.ts';
import { createBureauAgentCard } from './a2a-agent-card.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendResult,
  BureauA2AUser,
  createBureauA2ARequestHandler,
} from './a2a-request-handler.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import { buildBureauHandlerHost } from './create-bureau-handler.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';
import { respondToTask } from './management/tasks-respond-operation.ts';

const deploySchema: HumanInputSchema = {
  type: 'object',
  properties: {
    environment: { type: 'string', enum: ['staging', 'production'] },
    replicas: { type: 'integer' },
  },
  required: ['environment'],
  additionalProperties: false,
};

type Seen = { resumed: string[] };

function parksThenAnswers(seen: Seen): GenerateFunction {
  let calls = 0;
  return async (context: GenerateContext) => {
    calls += 1;
    if (calls === 1) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'wait-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'deploy', prompt: 'Where should this deploy?' },
          },
        ],
      };
    }
    seen.resumed.push(JSON.stringify(context.conversation.current));
    return { content: 'done', toolCalls: [] };
  };
}

async function statusOf(
  bureau: { tasks: { get(id: string): Promise<TaskView | undefined> } },
  id: string,
): Promise<string | undefined> {
  const view = await bureau.tasks.get(id);
  return view?.status;
}

function userMessage(messageId: string, taskId: string, part: Record<string, unknown>): Message {
  return Message.fromJSON({ messageId, taskId, role: 'ROLE_USER', parts: [part] });
}

async function open(schema: HumanInputSchema | undefined) {
  const seen: Seen = { resumed: [] };
  const opened = await openBureau({
    agents: { asker: createAgent({ name: 'asker', generate: parksThenAnswers(seen) }) },
    publish: ['asker'],
    // The schema is configured the way a host configures it: on the Bureau option, per signal.
    humanInput: schema === undefined ? true : { inputSchemas: { deploy: schema } },
  });
  const bureau = opened.bureau;
  const runtime = createDefaultRuntimeServices();
  const host = buildBureauHandlerHost(bureau, ['asker']);
  const card = createBureauAgentCard({
    catalogName: 'asker',
    displayName: undefined,
    description: undefined,
    definitionRevision: 1,
    skillDescriptors: undefined,
    security: undefined,
    durableHistory: false,
    pushNotifications: false,
  });
  const handler = createBureauA2ARequestHandler({
    publicUrl: 'http://localhost',
    agentName: 'asker',
    card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
    bureau,
    records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
    ledger: createCommandLedger<A2ASendClaim, A2ASendResult>({
      kv: textValueStore(new MemoryStorage()),
      keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
      clock: runtime.clock,
      nextConflictId: () => runtime.identifiers.next('conflict'),
    }),
    respond: (principal, input) => respondToTask(host, principal, input),
  });
  const principal = principalFromApiKey({ subject: 'alice', scopes: [] });
  const context = () =>
    new ServerCallContext({ user: new BureauA2AUser(principal), requestedVersion: '1.0' });
  const send = (message: Message) =>
    handler.sendMessage(
      { tenant: '', message, configuration: undefined, metadata: undefined },
      context(),
    );
  const start = async (): Promise<Task> => {
    const parked = await send(
      Message.fromJSON({ messageId: 'm-start', role: 'ROLE_USER', parts: [{ text: 'deploy' }] }),
    );
    if (!('status' in parked)) throw new Error('expected a task');
    expect(parked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    return parked;
  };
  return { opened, bureau, host, principal, handler, send, start, seen, context };
}

describe('an INPUT_REQUIRED task whose wait carries an input schema', () => {
  it('projects a text part with the prompt and the A2UI form as data parts', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();
      const message = task.status?.message;

      const parts = message?.parts.map((part) => part.content) ?? [];
      expect(parts[0]?.$case).toBe('text');
      expect(parts[0]?.$case === 'text' && parts[0].value).toContain('Where should this deploy?');
      const data = message?.parts.filter((part) => part.content?.$case === 'data') ?? [];
      // One data part holds the form's messages as an array, typed as A2UI's media type.
      expect(data).toHaveLength(1);
      expect(data[0]?.mediaType).toBe('application/a2ui+json');
      expect(data[0]?.metadata).toEqual({ mimeType: 'application/a2ui+json' });
      const messages =
        data[0]?.content?.$case === 'data' ? (data[0].content.value as Record<string, any>[]) : [];
      const [create, update] = messages;
      expect(create?.['createSurface']).toMatchObject({
        surfaceId: `input-form:human-wait:${task.id}:deploy:0`,
      });
      expect(
        update?.['updateComponents'].components.map((c: { component: string }) => c.component),
      ).toEqual(['ChoicePicker', 'TextField', 'Text', 'Button', 'Column']);
      expect(message?.metadata).toEqual({ signalNames: ['deploy'] });
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is the plain waiting message, with no form, when the wait has no schema', async () => {
    const fixture = await open(undefined);
    try {
      const task = await fixture.start();

      expect(task.status?.message?.parts).toHaveLength(1);
      expect(task.status?.message?.parts[0]?.content?.$case).toBe('text');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('delivers a submission that satisfies the schema to the waiting signal', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();

      await fixture.send(
        userMessage('m-submit', task.id, {
          data: { environment: 'staging', replicas: 3 },
        }),
      );

      await waitForCondition(
        async () => (await statusOf(fixture.bureau, task.id)) === 'completed',
        'the answered task never completed',
      );
      const resumed = fixture.seen.resumed.join('\n');
      expect(resumed).toContain('staging');
      expect(resumed).toContain('replicas');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('accepts the A2UI client-to-server action envelope as Chat’s renderer sends it', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();
      const envelope = [
        {
          version: 'v0.9',
          action: {
            name: 'submit-input',
            surfaceId: `input-form:human-wait:${task.id}:deploy:0`,
            sourceComponentId: 'submit',
            timestamp: '2026-10-23T12:00:00.000Z',
            // A ChoicePicker writes a list, and a number field writes text.
            context: { environment: ['staging'], replicas: '3' },
          },
        },
      ];

      await fixture.send(userMessage('m-envelope', task.id, { data: envelope }));

      await waitForCondition(
        async () => (await statusOf(fixture.bureau, task.id)) === 'completed',
        'the answered task never completed',
      );
      expect(fixture.seen.resumed.join('\n')).toContain('staging');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('refuses an envelope that is not a submit action for this wait’s surface', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();
      const action = (overrides: Record<string, unknown>) => [
        {
          version: 'v0.9',
          action: {
            name: 'submit-input',
            surfaceId: `input-form:human-wait:${task.id}:deploy:0`,
            context: { environment: 'staging' },
            ...overrides,
          },
        },
      ];

      for (const [index, data] of [
        [],
        [{ version: 'v0.9', error: { code: 'x' } }],
        action({ name: 'other' }),
        action({ surfaceId: 'input-form:elsewhere' }),
        action({ context: 'staging' }),
      ].entries()) {
        const refusal = await rejectionOf(
          fixture.send(userMessage(`m-env-${index}`, task.id, { data })),
        );
        expect(refusal).toBeInstanceOf(RequestMalformedError);
      }
      const view = await fixture.bureau.tasks.get(task.id);
      expect(view?.status).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('names the wait to answer in metadata.signalName', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();
      const message = userMessage('m-submit', task.id, { data: { environment: 'production' } });
      message.metadata = { signalName: 'deploy' };

      await fixture.send(message);

      await waitForCondition(
        async () => (await statusOf(fixture.bureau, task.id)) === 'completed',
        'the answered task never completed',
      );
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('refuses a submission that does not satisfy the schema, and the wait stays open', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();

      for (const [index, submitted] of [
        { environment: 'moon' },
        { replicas: 3 },
        { environment: 'staging', replicas: 'many' },
        { environment: 'staging', admin: true },
      ].entries()) {
        const refusal = await rejectionOf(
          fixture.send(userMessage(`m-bad-${index}`, task.id, { data: submitted })),
        );
        expect(refusal).toBeInstanceOf(RequestMalformedError);
      }

      const view = await fixture.bureau.tasks.get(task.id);
      expect(view?.status).toBe('input-required');
      expect(fixture.seen.resumed).toEqual([]);
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('refuses a text answer, which the schema cannot vouch for', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();

      const refusal = await rejectionOf(
        fixture.send(userMessage('m-text', task.id, { text: 'staging' })),
      );

      expect(refusal).toBeInstanceOf(RequestMalformedError);
      expect(await statusOf(fixture.bureau, task.id)).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('refuses a submission that is not a JSON object', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();

      const refusal = await rejectionOf(
        fixture.send(userMessage('m-array', task.id, { data: ['staging'] })),
      );

      expect(refusal).toBeInstanceOf(RequestMalformedError);
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('parses a { response } submission of a form it could not map', async () => {
    const fixture = await open({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['tags'],
    });
    try {
      const task = await fixture.start();
      const refusal = await rejectionOf(
        fixture.send(userMessage('m-empty', task.id, { data: { response: '{"tags":[]}' } })),
      );
      expect(refusal).toBeInstanceOf(RequestMalformedError);

      await fixture.send(
        userMessage('m-tags', task.id, { data: { response: '{"tags":["a","b"]}' } }),
      );

      await waitForCondition(
        async () => (await statusOf(fixture.bureau, task.id)) === 'completed',
        'the answered task never completed',
      );
      expect(fixture.seen.resumed.join('\n')).toContain('tags');
    } finally {
      await fixture.opened.dispose();
    }
  });
});

describe('a data answer to a wait with no schema', () => {
  it('is refused as a continuation', async () => {
    const fixture = await open(undefined);
    try {
      const task = await fixture.start();

      const refusal = await rejectionOf(
        fixture.send(userMessage('m-data', task.id, { data: { environment: 'staging' } })),
      );

      expect(refusal).toBeInstanceOf(RequestMalformedError);
      expect(await statusOf(fixture.bureau, task.id)).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is refused by bureau.tasks.respond too', async () => {
    const fixture = await open(undefined);
    try {
      const task = await fixture.start();

      const fault = await rejectionOf(
        respondToTask(fixture.host, fixture.principal, {
          taskId: task.id,
          messageId: 'r-data',
          data: { environment: 'staging' },
        }),
      );

      expect(fault).toMatchObject({ code: 'Unprocessable' });
    } finally {
      await fixture.opened.dispose();
    }
  });
});

describe('bureau.tasks.respond on a wait with an input schema', () => {
  it('validates data for every caller, not only an A2A one', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();
      const respond = (input: Record<string, unknown>) =>
        respondToTask(fixture.host, fixture.principal, {
          taskId: task.id,
          messageId: String(input['messageId']),
          ...input,
        });

      expect(
        await rejectionOf(respond({ messageId: 'r-1', data: { environment: 'moon' } })),
      ).toMatchObject({ code: 'InvalidParams' });
      expect(await rejectionOf(respond({ messageId: 'r-2', answer: 'staging' }))).toMatchObject({
        code: 'Unprocessable',
      });
      expect(await rejectionOf(respond({ messageId: 'r-3', decision: 'approve' }))).toMatchObject({
        code: 'InvalidParams',
      });
      expect(await statusOf(fixture.bureau, task.id)).toBe('input-required');

      const applied = await respond({ messageId: 'r-4', data: { environment: 'staging' } });
      expect(applied).toMatchObject({ kind: 'human-wait', receipt: 'applied' });
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('lets a deny close the wait without data', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();

      const denied = await respondToTask(fixture.host, fixture.principal, {
        taskId: task.id,
        messageId: 'r-deny',
        decision: 'deny',
      });

      expect(denied).toMatchObject({ kind: 'human-wait', decision: 'deny' });
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('answers a retry of the same data with the same receipt, whatever its key order', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();
      const first = await respondToTask(fixture.host, fixture.principal, {
        taskId: task.id,
        messageId: 'r-retry',
        data: { environment: 'staging', replicas: 2 },
      });

      const second = await respondToTask(fixture.host, fixture.principal, {
        taskId: task.id,
        messageId: 'r-retry',
        data: { replicas: 2, environment: 'staging' },
      });

      expect(second).toEqual(first);
      const different = await rejectionOf(
        respondToTask(fixture.host, fixture.principal, {
          taskId: task.id,
          messageId: 'r-retry',
          data: { environment: 'production' },
        }),
      );
      expect(different).toMatchObject({ code: 'Conflict' });
    } finally {
      await fixture.opened.dispose();
    }
  });
});
