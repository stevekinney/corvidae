import { describe, expect, it } from 'bun:test';

import {
  a2uiHarness,
  createMessage,
  surfaceField,
  panelComponents,
  TASK,
  updateComponentsMessage,
} from './a2ui.test-support';
import { createProposeA2uiSurfaceTool } from './propose-surface-tool';

function toolFor(h: ReturnType<typeof a2uiHarness>, continuation = true) {
  return createProposeA2uiSurfaceTool({
    adapter: h.adapter,
    taskId: TASK,
    ...(continuation
      ? {
          continuationFor: () =>
            ({ type: 'signal', sessionId: 'session-1', signalName: 'confirmed' }) as const,
        }
      : {}),
  });
}

async function run(tool: ReturnType<typeof toolFor>, input: unknown) {
  const output: unknown = await tool.execute(input as never);
  return JSON.parse(String(output)) as Record<string, unknown>;
}

const proposal = {
  surfaceId: 'panel',
  messages: [createMessage('panel'), updateComponentsMessage('panel', panelComponents())],
  actions: [{ name: 'confirm', intent: 'submit' as const }],
};

describe('the model-facing proposal tool', () => {
  it('stores a valid proposal as an a2ui surface, equally to author code', async () => {
    const h = a2uiHarness();
    const result = await run(toolFor(h), proposal);
    expect(result).toMatchObject({ outcome: 'accepted', surfaceId: 'panel', revision: 1 });
    expect(await h.snapshot('panel')).toMatchObject({
      kind: 'a2ui',
      actions: [{ name: 'confirm', continuation: { type: 'signal', signalName: 'confirmed' } }],
    });
  });

  it('returns structured feedback for an invalid proposal and commits nothing', async () => {
    const h = a2uiHarness();
    const result = await run(toolFor(h), {
      ...proposal,
      messages: [
        createMessage('panel'),
        updateComponentsMessage('panel', [{ id: 'root', component: 'Iframe', src: 'x' }]),
      ],
    });
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    expect((result['issues'] as unknown[]).length).toBeGreaterThan(0);
    await expect(h.snapshot('panel')).rejects.toThrow();
  });

  it('cannot give a component an action the model did not declare, nor choose the continuation', async () => {
    const h = a2uiHarness();
    const undeclared = await run(toolFor(h), { ...proposal, actions: [] });
    expect(undeclared).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    const sneaky = await run(toolFor(h), {
      ...proposal,
      actions: [
        { name: 'confirm', intent: 'submit', continuation: { type: 'review', reviewId: 'r-1' } },
      ],
    });
    expect(sneaky).toMatchObject({ outcome: 'accepted' });
    expect(await h.snapshot('panel')).toMatchObject({
      actions: [{ continuation: { type: 'signal' } }],
    });
  });

  it('makes a surface display-only when the host offers no continuation', async () => {
    const h = a2uiHarness();
    const result = await run(toolFor(h, false), proposal);
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'unsupported-capability' });
  });

  it('refuses a catalog that was not negotiated', async () => {
    const h = a2uiHarness();
    const result = await run(toolFor(h), {
      ...proposal,
      messages: [
        createMessage(
          'panel',
          'https://cinder.website/a2ui/v0_9_1/catalogs/cinder/v1/catalog.json',
        ),
      ],
    });
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'unsupported-capability' });
  });

  it('acts only within its own task', async () => {
    const h = a2uiHarness({
      [TASK]: { owner: 'api-key:alice', contextId: 'session-1' },
      other: { owner: 'api-key:alice', contextId: 't' },
    });
    await run(toolFor(h), proposal);
    const otherTool = createProposeA2uiSurfaceTool({ adapter: h.adapter, taskId: 'other' });
    const result = await run(otherTool, {
      surfaceId: 'panel',
      messages: [updateComponentsMessage('panel', [{ id: 'title', component: 'Text', text: 'x' }])],
    });
    expect(result['outcome']).toBe('rejected');
    expect(await surfaceField(h, 'panel', 'revision')).toBe(1);
  });
});
