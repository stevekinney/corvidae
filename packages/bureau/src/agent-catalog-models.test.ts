/**
 * COR-1708 — `bureau.agents.models(name)` is the in-process counterpart of the served
 * `bureau.agents.models` operation: it describes what one agent allows a session to be switched
 * to, against the deployment's model catalog as it is when the call is made.
 */
import { createAgent, createMockGenerate, createModelCatalog } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { type AgentDefinitions, createAgentCatalog } from './agent-catalog';
import type { BureauModelPolicyOptions } from './model-policy';
import { createBureau } from './create-bureau';
import { OPUS_5, OPUS_5_5 } from './testing/model-override.test-support';
import type { Bureau } from './types';
import { MemoryStorage } from '@lostgradient/storage';

const bureaus: Bureau[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function open(): Promise<Bureau> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      switchable: createAgent({
        generate: createMockGenerate([]),
        name: 'switchable',
        allowedCandidates: [OPUS_5_5, OPUS_5],
      }),
      opaque: createAgent({ generate: createMockGenerate([]), name: 'opaque' }),
    },
    storage: new MemoryStorage(),
  });
  bureaus.push(bureau);
  return bureau;
}

describe('agents.models', () => {
  it('describes a selectable agent by the candidates the catalog holds', async () => {
    const bureau = await open();

    const described = bureau.agents.models('switchable');

    expect(described?.kind).toBe('selectable');
    expect(described?.selectable).toBe(true);
    expect(
      described?.models.map((choice) => `${choice.provider}/${choice.model}`).toSorted(),
    ).toEqual(
      [`${OPUS_5.provider}/${OPUS_5.model}`, `${OPUS_5_5.provider}/${OPUS_5_5.model}`].toSorted(),
    );
  });

  it('reports an agent whose backend Bureau cannot know as not selectable, with no models', async () => {
    const bureau = await open();

    expect(bureau.agents.models('opaque')).toMatchObject({
      kind: 'opaque',
      selectable: false,
      models: [],
      default: null,
    });
  });

  it('resolves undefined for a name no agent has', async () => {
    const bureau = await open();

    expect(bureau.agents.models('nobody')).toBeUndefined();
  });

  it('reads the catalog as it is at the call, so a replaced catalog changes the answer', async () => {
    const bureau = await open();
    const before = bureau.agents.models('switchable');
    expect(before?.models.length).toBeGreaterThan(0);

    const kept = bureau.models
      .catalog()
      .descriptors.filter(
        (row) => row.provider === OPUS_5_5.provider && row.model === OPUS_5_5.model,
      );
    bureau.models.replace(kept);

    expect(bureau.agents.models('switchable')?.models).toEqual([
      { provider: OPUS_5_5.provider, model: OPUS_5_5.model, displayName: OPUS_5_5.model },
    ]);
  });
});

describe('agents.models under the model policy (COR-1996)', () => {
  it('reads the policy at the call: a model is marked denied once the policy forbids it, and unmarked when it lifts', () => {
    const agent = createAgent({
      generate: createMockGenerate([]),
      name: 'switchable',
      allowedCandidates: [OPUS_5_5, OPUS_5],
    });
    let policy: BureauModelPolicyOptions | undefined;
    const catalog = createAgentCatalog(
      { switchable: agent },
      { descriptors: () => createModelCatalog().descriptors, modelPolicy: () => policy },
    );
    const deniedOf = () =>
      Object.fromEntries(
        (catalog.models('switchable')?.models ?? []).map((choice) => [
          choice.model,
          choice.denied === true,
        ]),
      );

    expect(deniedOf()).toEqual({ [OPUS_5_5.model]: false, [OPUS_5.model]: false });

    policy = { bureau: { deniedModels: [OPUS_5.model] }, policyRevision: 2 };
    expect(deniedOf()).toEqual({ [OPUS_5_5.model]: false, [OPUS_5.model]: true });

    policy = undefined;
    expect(deniedOf()).toEqual({ [OPUS_5_5.model]: false, [OPUS_5.model]: false });
  });
});
