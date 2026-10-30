/**
 * COR-1935 — `bureau.contexts.steer` sets a context's reasoning effort by an `effort` key beside
 * `override`, of which a request carries exactly one; the effort is used from the next step of a
 * live run and by the next run of an idle context; `bureau.contexts.get` reads the settled one back.
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForTaskState } from '../../test';
import {
  createSteppedGenerate,
  noopTool,
  OPUS_5,
  OPUS_5_5,
} from '../../testing/model-override.test-support.ts';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';
import {
  exactlyOneSettingIssue,
  requestedValueOf,
  steeredSettingKey,
} from './contexts-steer-operation.ts';

function steppedPicker() {
  const stepped = createSteppedGenerate();
  const picker = createAgent({
    name: 'picker',
    generate: stepped.generate,
    tools: { noop: noopTool },
    allowedCandidates: [OPUS_5_5, OPUS_5],
  });
  return { stepped, picker };
}

async function withBureau<T>(
  picker: ReturnType<typeof steppedPicker>['picker'],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau({ agents: { picker } });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

const steer = (opened: OpenedBureau, contextId: string, commandId: string, params: object) =>
  rpc(opened.handler, 'bureau.contexts.steer', { contextId, commandId, ...params }, 'alice-key');

/** What `bureau.contexts.get` answers for the context. */
const settled = async (opened: OpenedBureau, contextId: string) => {
  const body = await rpc(opened.handler, 'bureau.contexts.get', { contextId }, 'alice-key');
  return body.result;
};

describe('bureau.contexts.steer effort', () => {
  it('applies from the next step of a running chat, and get reads the settled effort back', async () => {
    const { stepped, picker } = steppedPicker();
    await withBureau(picker, async (opened) => {
      const run = await opened.bureau.tasks.start('picker', 'work', { principal: OWNER.alice });
      await stepped.firstStepEntered;

      const body = await steer(opened, run.contextId, 'raise', { effort: 'high' });
      stepped.releaseFirstStep();
      await waitForTaskState(opened.bureau, run.id);

      expect(body.result).toMatchObject({
        outcome: 'accepted',
        command: { requestedValue: { target: 'effort', override: 'high' }, configVersion: 1 },
      });
      // Step 0 was already running; the next step takes the effort.
      expect(stepped.observed.map((step) => step.effort)).toEqual([undefined, 'high']);
      expect(await settled(opened, run.contextId)).toMatchObject({
        effort: 'high',
        model: null,
        configVersion: 1,
      });
    });
  });

  it('applies to the next run of an idle chat, which no pause could steer', async () => {
    const { stepped, picker } = steppedPicker();
    stepped.releaseFirstStep();
    await withBureau(picker, async (opened) => {
      const first = await opened.bureau.tasks.start('picker', 'work', { principal: OWNER.alice });
      await waitForTaskState(opened.bureau, first.id);
      const before = stepped.observed.length;

      const idle = await steer(opened, first.contextId, 'idle-effort', { effort: 'low' });
      const pause = await opened.bureau.contexts.steer(first.contextId, {
        id: 'idle-pause',
        principal: OWNER.alice,
        requestedValue: { target: 'pause' },
      });
      const second = await opened.bureau.tasks.start('picker', 'again', {
        contextId: first.contextId,
        principal: OWNER.alice,
      });
      await waitForTaskState(opened.bureau, second.id);

      expect(idle.result).toMatchObject({ outcome: 'accepted' });
      expect(pause.outcome).toBe('session-terminal');
      expect(stepped.observed.slice(before).map((step) => step.effort)).toEqual(['low', 'low']);
      expect(await settled(opened, first.contextId)).toMatchObject({ effort: 'low' });
    });
  });

  it('keeps the model and the effort apart: each is read back, and a later one does not clear the other', async () => {
    const { stepped, picker } = steppedPicker();
    stepped.releaseFirstStep();
    await withBureau(picker, async (opened) => {
      const run = await opened.bureau.tasks.start('picker', 'work', { principal: OWNER.alice });
      await waitForTaskState(opened.bureau, run.id);

      expect(await settled(opened, run.contextId)).toMatchObject({
        effort: null,
        model: null,
        configVersion: 0,
      });
      await steer(opened, run.contextId, 'model', { override: OPUS_5 });
      await steer(opened, run.contextId, 'effort', { effort: 'max' });

      expect(await settled(opened, run.contextId)).toMatchObject({
        effort: 'max',
        model: { provider: 'anthropic', model: 'claude-opus-5' },
        configVersion: 2,
      });
    });
  });

  it('refuses a request with several or none of override, effort and permissionMode, naming the field, and changes nothing', async () => {
    const { stepped, picker } = steppedPicker();
    stepped.releaseFirstStep();
    await withBureau(picker, async (opened) => {
      const run = await opened.bureau.tasks.start('picker', 'work', { principal: OWNER.alice });
      await waitForTaskState(opened.bureau, run.id);

      const both = await steer(opened, run.contextId, 'both', { override: OPUS_5, effort: 'high' });
      const neither = await steer(opened, run.contextId, 'neither', {});
      const wrongEffort = await steer(opened, run.contextId, 'wrong', { effort: 'turbo' });

      const issuesOf = (body: RpcBody) => body.error?.data?.['issues'];
      expect(both.error?.data?.['weftCode']).toBe('InvalidParams');
      expect(issuesOf(both)).toEqual([
        {
          path: ['effort'],
          message:
            'Exactly one of `override`, `effort` and `permissionMode` is allowed; `override` and `effort` were sent',
          code: 'custom',
        },
      ]);
      expect(neither.error?.data?.['weftCode']).toBe('InvalidParams');
      expect(issuesOf(neither)).toEqual([
        {
          path: ['override'],
          message:
            'Exactly one of `override`, `effort` and `permissionMode` is required; none was sent',
          code: 'custom',
        },
      ]);
      expect(wrongEffort.error?.data?.['weftCode']).toBe('InvalidParams');
      expect(issuesOf(wrongEffort)).toEqual([
        expect.objectContaining({ path: ['effort'], code: 'invalid_value' }),
      ]);
      expect(await settled(opened, run.contextId)).toMatchObject({
        effort: null,
        model: null,
        configVersion: 0,
      });
    });
  });
});

describe('the exactly-one rule reads its keys from one list', () => {
  const keys = ['override', 'effort', 'permissionMode', 'tone'];

  it('counts and names a hypothetical fourth setting', () => {
    expect(exactlyOneSettingIssue({}, keys)).toEqual({
      path: ['override'],
      message:
        'Exactly one of `override`, `effort`, `permissionMode` and `tone` is required; none was sent',
    });
    expect(exactlyOneSettingIssue({ effort: 'low', tone: 'terse' }, keys)).toEqual({
      path: ['tone'],
      message:
        'Exactly one of `override`, `effort`, `permissionMode` and `tone` is allowed; `effort` and `tone` were sent',
    });
    expect(exactlyOneSettingIssue({ tone: 'terse' }, keys)).toBeUndefined();
    expect(steeredSettingKey({ tone: 'terse' }, keys)).toBe('tone');
  });

  it('does not read a request naming only another setting as an effort', () => {
    const fourth = { contextId: 'c', commandId: 'k', tone: 'terse' };

    expect(() => requestedValueOf(fourth as never)).toThrow('names none of the settings');
    expect(requestedValueOf({ contextId: 'c', commandId: 'k', effort: 'low' })).toEqual({
      target: 'effort',
      override: 'low',
    });
    expect(
      requestedValueOf({ contextId: 'c', commandId: 'k', permissionMode: 'read-only' }),
    ).toEqual({
      target: 'permission-mode',
      override: 'read-only',
    });
  });
});
