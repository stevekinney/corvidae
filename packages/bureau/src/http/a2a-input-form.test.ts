/**
 * COR-1487 — an `INPUT_REQUIRED` task whose human wait carries an input schema is projected with an
 * A2UI form, and the form's submission is validated against the schema before the wait is released.
 *
 * The schema is configured on the Bureau (`humanInput: { inputSchemas }`, COR-1674), so the park
 * carries it from the real tool with nothing injected; the answer then travels the real path: the
 * A2A continuation, `bureau.tasks.respond`, `reviews.resolve`, and the engine's signal.
 */
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import { describe, expect, it } from 'bun:test';

import { A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import { waitForCondition } from '../test';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { deploySchema, open, statusOf, userMessage } from './a2a-input-form.test-support.ts';
import { respondToTask } from './management/tasks-respond-operation.ts';

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

  it('projects only the prompt text to a request that did not activate A2UI', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();

      const read = await fixture.read(task.id, []);

      expect(read.status?.message?.parts).toHaveLength(1);
      expect(read.status?.message?.parts[0]?.content?.$case).toBe('text');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('closes the answered form’s surface when the task parks again, on another signal', async () => {
    const fixture = await open(deploySchema, ['deploy', 'region']);
    try {
      const task = await fixture.start();
      await fixture.send(userMessage('m-first', task.id, { data: { environment: 'staging' } }));
      await waitForCondition(async () => {
        const view = await fixture.bureau.internals.taskRegistry.get(task.id);
        return (
          view?.status === 'input-required' &&
          view.openWaits.some((wait) => wait.kind === 'human-wait' && wait.signalName === 'region')
        );
      }, 'the task never parked on the second signal');

      const read = await fixture.read(task.id, [A2UI_EXTENSION_URI]);

      const data = (read.status?.message?.parts ?? []).find(
        (part) => part.content?.$case === 'data',
      );
      const messages =
        data?.content?.$case === 'data' ? (data.content.value as Record<string, any>[]) : [];
      expect(messages[0]).toEqual({
        version: 'v0.9',
        deleteSurface: { surfaceId: `input-form:human-wait:${task.id}:deploy:0` },
      });
      expect(messages[1]?.['createSurface'].surfaceId).toBe(
        `input-form:human-wait:${task.id}:region:1`,
      );
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
      const view = await fixture.bureau.internals.taskRegistry.get(task.id);
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

      const view = await fixture.bureau.internals.taskRegistry.get(task.id);
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
      // Text is read as the value it stands for: `staging` is not an object (COR-1804).
      expect(await rejectionOf(respond({ messageId: 'r-2', answer: 'staging' }))).toMatchObject({
        code: 'InvalidParams',
        data: { issues: [{ path: ['answer'], code: 'type' }] },
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

  it('takes text as written for a string schema, and refuses it field by field (COR-1804)', async () => {
    const fixture = await open({ type: 'string', maxLength: 5 });
    try {
      const task = await fixture.start();
      const respond = (messageId: string, answer: string) =>
        respondToTask(fixture.host, fixture.principal, { taskId: task.id, messageId, answer });

      expect(await rejectionOf(respond('r-1', 'far too long'))).toMatchObject({
        code: 'InvalidParams',
        data: { issues: [{ path: ['answer'], code: 'maxLength' }] },
      });
      expect(await statusOf(fixture.bureau, task.id)).toBe('input-required');

      // Not JSON, and not parsed as it: the text is the answer.
      expect(await respond('r-2', 'ready')).toMatchObject({
        kind: 'human-wait',
        receipt: 'applied',
      });
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('reads text as JSON for a schema that asks for more than a string (COR-1804)', async () => {
    const fixture = await open(deploySchema);
    try {
      const task = await fixture.start();
      const respond = (messageId: string, answer: string) =>
        respondToTask(fixture.host, fixture.principal, { taskId: task.id, messageId, answer });

      expect(await rejectionOf(respond('r-1', '{"environment":"moon"}'))).toMatchObject({
        code: 'InvalidParams',
        data: { issues: [{ path: ['answer', 'environment'], code: 'enum' }] },
      });
      expect(await statusOf(fixture.bureau, task.id)).toBe('input-required');

      expect(await respond('r-2', '{"environment":"staging"}')).toMatchObject({
        kind: 'human-wait',
        receipt: 'applied',
      });
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('asserts a date-time answer’s format, which the form check leaves as an annotation (COR-1804)', async () => {
    const fixture = await open({
      type: 'object',
      properties: { when: { type: 'string', format: 'date-time' } },
      required: ['when'],
    });
    try {
      const task = await fixture.start();
      const respond = (messageId: string, when: string) =>
        respondToTask(fixture.host, fixture.principal, {
          taskId: task.id,
          messageId,
          data: { when },
        });

      expect(await rejectionOf(respond('r-1', 'tomorrow'))).toMatchObject({
        code: 'InvalidParams',
      });
      expect(await statusOf(fixture.bureau, task.id)).toBe('input-required');

      const applied = await respond('r-2', '2026-10-29T14:30:00Z');
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
