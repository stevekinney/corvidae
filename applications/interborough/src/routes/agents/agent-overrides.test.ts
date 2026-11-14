/**
 * What a code agent's tabs write as overrides (COR-2229): each tab changes only the keys it owns
 * and the person changed from what the tab was filled with, sends every other override back as
 * last read or written, and a later write names the hash the one before it returned.
 */
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  agentFaultOf,
  type AgentDefinitionInput,
  type AgentDetail,
  type AgentOverridesState,
} from '../../lib/agent-definitions.ts';
import { readyAgent } from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import {
  AgentOverridesBinding,
  isOverridable,
  overridableDetail,
  overridesDefinition,
} from './agent-overrides.ts';

const NONE = {
  instructions: null,
  tools: null,
  approvals: null,
  guardrails: null,
  interceptors: null,
  escalations: null,
  limits: null,
  model: null,
  models: null,
  effort: null,
} satisfies AgentOverridesState['overrides'];

function code(overrides: Partial<AgentOverridesState['overrides']> = {}) {
  const detail: AgentDetail = {
    ...readyAgent({ id: 'demo:echo', name: 'echo' }),
    source: 'code',
    hash: null,
    definition: null,
    codeDefinition: {
      name: 'echo',
      description: null,
      model: 'anthropic/sonnet',
      models: ['anthropic/haiku'],
      tools: overrides.tools ?? ['lookup-order'],
      skills: [],
      card: [],
      instructions: overrides.instructions ?? 'Repeat it.',
    },
  };
  const state: AgentOverridesState = {
    id: 'demo:echo',
    hash: 'hash-0',
    version: null,
    overrides: { ...NONE, ...overrides },
    ownTools: ['lookup-order'],
  };
  return { detail, state };
}

/** The base definition a tab writes back, so a test names only what the person changed. */
function written(
  base: ReturnType<typeof overridesDefinition>,
  change: Partial<AgentDefinitionInput>,
): AgentDefinitionInput {
  return { ...base, ...change } as AgentDefinitionInput;
}

/** What a tab was filled with, which a write compares its definition with. */
const filledWith = (base: ReturnType<typeof overridesDefinition>): AgentDefinitionInput =>
  written(base, {});

const restores: (() => void)[] = [];
const bodies: Record<string, unknown>[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  bodies.length = 0;
});

/** A Bureau that takes overrides, numbering each save and returning its hash. */
function bureau(): void {
  let version = 0;
  restores.push(
    installFetchImplementation(async (_input, init) => {
      const text = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(text) as { params: Record<string, unknown> };
      bodies.push(body.params);
      version += 1;
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { id: 'demo:echo', hash: `hash-${String(version)}`, version },
      });
    }),
  );
}

describe('isOverridable', () => {
  test('is a ready agent defined in code that states itself, and nothing else', () => {
    expect(isOverridable(code().detail)).toBe(true);
    expect(isOverridable(readyAgent())).toBe(false);
    expect(isOverridable(undefined)).toBe(false);
    expect(isOverridable({ ...code().detail, state: 'unavailable' })).toBe(false);
    expect(isOverridable({ ...code().detail, codeDefinition: null })).toBe(false);
  });
});

describe('the agent as the tabs take it', () => {
  test('is a definition under the hash of the overrides, with the overrides applied', () => {
    const { detail, state } = code({
      effort: 'high',
      limits: { steps: 7 },
      approvals: { 'lookup-order': 'never' },
    });
    const shown = overridableDetail(detail, state);
    expect(shown.hash).toBe('hash-0');
    expect(shown.definition).toMatchObject({
      model: 'anthropic/sonnet',
      models: ['anthropic/haiku'],
      effort: 'high',
      limits: { steps: 7, cost: null },
      approvals: { 'lookup-order': 'never' },
      tools: ['lookup-order'],
      instructions: 'Repeat it.',
    });
  });

  test('holds the agent’s own tools until they are overridden, and no model as an empty one', () => {
    const { detail, state } = code();
    const none = {
      ...detail,
      codeDefinition: { ...detail.codeDefinition!, model: null, models: [] },
    };
    const definition = overridesDefinition(none, {
      ...state,
      ownTools: ['lookup-order', 'issue-refund'],
    });
    expect(definition.tools).toEqual(['lookup-order', 'issue-refund']);
    expect(definition.model).toBe('');
    expect(definition.models).toBeNull();
  });
});

describe('writing overrides', () => {
  test('sends only what the Settings tab changed, and leaves the rest as the agent’s own', async () => {
    bureau();
    const { detail, state } = code();
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);

    const result = await binding.writerFor('settings')(
      'hash-0',
      written(base, { instructions: 'Be terse.' }),
      filledWith(base),
    );

    expect(result.hash).toBe('hash-1');
    expect(bodies[0]).toEqual({
      id: 'demo:echo',
      expectedHash: 'hash-0',
      overrides: { instructions: 'Be terse.' },
    });
  });

  test('sends back the overrides of the other tab and the ones no tab edits, as last read', async () => {
    bureau();
    const { detail, state } = code({
      tools: ['lookup-order'],
      interceptors: ['demo:audit'],
      escalations: ['demo:taint'],
      limits: { cost: { run: 2 }, tools: { calls: 3 } },
      approvals: { 'lookup-order': 'always' },
    });
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);

    await binding.writerFor('settings')(
      'hash-0',
      written(base, { model: 'anthropic/haiku', limits: { steps: 9 } }),
      filledWith(base),
    );

    expect(bodies[0]?.['overrides']).toEqual({
      tools: ['lookup-order'],
      interceptors: ['demo:audit'],
      escalations: ['demo:taint'],
      approvals: { 'lookup-order': 'always' },
      model: 'anthropic/haiku',
      limits: { steps: 9, cost: { run: 2 }, tools: { calls: 3 } },
    });
  });

  test('writes a tool change from Access over the hash the Settings write returned, keeping its instructions', async () => {
    bureau();
    const { detail, state } = code();
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);

    await binding.writerFor('settings')(
      'hash-0',
      written(base, { instructions: 'Be terse.' }),
      filledWith(base),
    );
    await binding.writerFor('access')(
      'hash-1',
      written(base, { tools: ['lookup-order', 'issue-refund'] }),
      filledWith(base),
    );

    expect(bodies[1]).toEqual({
      id: 'demo:echo',
      expectedHash: 'hash-1',
      overrides: { instructions: 'Be terse.', tools: ['lookup-order', 'issue-refund'] },
    });
  });

  test('takes a key back to the agent’s own when it is emptied: no instructions, no model, no limit', async () => {
    bureau();
    const { detail, state } = code({
      instructions: 'Old.',
      model: 'anthropic/haiku',
      limits: { steps: 4 },
    });
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);

    await binding.writerFor('settings')(
      'hash-0',
      written(base, { instructions: '  ', model: '', limits: { steps: null } }),
      filledWith(base),
    );

    expect(bodies[0]?.['overrides']).toEqual({});
  });

  test('a tool allowed and then withdrawn again is written as what the agent has, never lost', async () => {
    bureau();
    const { detail, state } = code();
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);
    const allowed = written(base, { tools: ['lookup-order', 'issue-refund'] });

    await binding.writerFor('access')('hash-0', allowed, filledWith(base));
    // The tab was last written as `allowed`, so withdrawing the tool is its change.
    await binding.writerFor('access')(
      'hash-1',
      written(base, { tools: ['lookup-order'] }),
      allowed,
    );

    expect(bodies[1]?.['overrides']).toEqual({ tools: ['lookup-order'] });
  });

  test('keeps what it holds when the Bureau answers with the same hash, and takes up any other', async () => {
    bureau();
    const { detail, state } = code();
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);
    await binding.writerFor('settings')(
      'hash-0',
      written(base, { instructions: 'Be terse.' }),
      filledWith(base),
    );

    // The read that follows the save answers with the hash it made: nothing to take up.
    binding.sync({
      ...state,
      hash: 'hash-1',
      overrides: { ...NONE, instructions: 'Be terse.' },
    });
    expect(binding.overrides?.instructions).toBe('Be terse.');
    // A change made elsewhere replaces what it holds.
    binding.sync({
      ...state,
      hash: 'hash-9',
      overrides: { ...NONE, model: 'anthropic/haiku' },
    });
    expect(binding.overrides).toMatchObject({ instructions: null, model: 'anthropic/haiku' });
  });

  test('after a Restore brings back a set it held before, takes that set up and writes over it, never over the one the Restore replaced', async () => {
    bureau();
    const { detail, state } = code();
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);
    // Instructions X (a hash this binding wrote), then Y, then a Restore of X: the hash is X's again.
    const asX = written(base, { instructions: 'X' });
    await binding.writerFor('settings')('hash-0', asX, filledWith(base));
    const restoredHash = 'hash-1';
    await binding.writerFor('settings')(restoredHash, written(base, { instructions: 'Y' }), asX);
    expect(binding.overrides?.instructions).toBe('Y');

    const restored = { ...state, hash: restoredHash, overrides: { ...NONE, instructions: 'X' } };
    binding.sync(restored);
    expect(binding.overrides?.instructions).toBe('X');

    const restoredBase = overridesDefinition(detail, restored);
    await binding.writerFor('access')(
      restoredHash,
      written(restoredBase, { tools: ['lookup-order', 'issue-refund'] }),
      filledWith(restoredBase),
    );
    expect(bodies.at(-1)?.['overrides']).toEqual({
      instructions: 'X',
      tools: ['lookup-order', 'issue-refund'],
    });
  });

  test('refuses a write that names a hash other than the one it built its changes over, and writes nothing', async () => {
    bureau();
    const { detail, state } = code();
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);

    const refused = await binding
      .writerFor('settings')(
        'hash-stale',
        written(base, { instructions: 'Lost.' }),
        filledWith(base),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(agentFaultOf(refused)).toEqual({ kind: 'stale', currentHash: 'hash-0' });
    expect(bodies).toEqual([]);
  });

  test('refuses to write before the overrides were read', async () => {
    const binding = new AgentOverridesBinding('demo:echo');
    const { detail, state } = code();
    const base = overridesDefinition(detail, state);
    const refused = await rejectionOf(
      binding.writerFor('settings')('hash-0', written(base, {}), filledWith(base)),
    );
    expect(String(refused)).toContain('have not been read');
  });
});

describe('a save never writes an override nobody made (COR-2229)', () => {
  test('a tab filled again after the person emptied the instructions writes only the field they changed', async () => {
    bureau();
    // Instructions overridden to "X"; the agent's own are "Repeat it.".
    const overridden = code({ instructions: 'X' });
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(overridden.state);
    const firstBase = overridesDefinition(overridden.detail, overridden.state);
    // The person empties Instructions, which takes the override away, and saves.
    await binding.writerFor('settings')(
      'hash-0',
      written(firstBase, { instructions: '' }),
      filledWith(firstBase),
    );
    expect(bodies[0]?.['overrides']).toEqual({});

    // The page reads both again; another tab and back mounts Settings again, now filled with the
    // agent's own instructions. The person changes only the effort.
    const after: AgentOverridesState = { ...overridden.state, hash: 'hash-1', overrides: NONE };
    const fresh = code().detail;
    binding.sync(after);
    const secondBase = overridesDefinition(fresh, after);
    expect(secondBase.instructions).toBe('Repeat it.');
    await binding.writerFor('settings')(
      'hash-1',
      written(secondBase, { effort: 'low' }),
      filledWith(secondBase),
    );

    expect(bodies[1]?.['overrides']).toEqual({ effort: 'low' });
  });

  test('a form filled from a Restore whose overrides landed before its definition writes no override of the instructions or the model', async () => {
    bureau();
    // Before the Restore, version 2 overrides the instructions and the model.
    const before = code({ instructions: 'X', model: 'anthropic/haiku' });
    // The Restore brings back version 1, which changed only the effort.
    const restored: AgentOverridesState = {
      ...before.state,
      hash: 'hash-1',
      overrides: { ...NONE, effort: 'high' },
    };
    const staleDetail = before.detail; // states the instructions with the old overrides applied
    const freshDetail = code().detail; // the agent's own, once nothing overrides them
    // A form filled from the stale pair, or from the fresh one, is a form the person changed one
    // field of: only that field is written, whichever pair filled it.
    for (const detail of [staleDetail, freshDetail]) {
      const binding = new AgentOverridesBinding('demo:echo');
      binding.sync(before.state);
      binding.sync(restored);
      const base = overridesDefinition(detail, restored);
      bodies.length = 0;
      await binding.writerFor('settings')(
        'hash-1',
        written(base, { effort: 'low' }),
        filledWith(base),
      );
      expect(bodies[0]?.['overrides']).toEqual({ effort: 'low' });
    }
  });

  test('an Access write sends the instructions and the model overrides as they were, and only its own change', async () => {
    bureau();
    const { detail, state } = code({ instructions: 'X', model: 'anthropic/haiku' });
    const binding = new AgentOverridesBinding('demo:echo');
    binding.sync(state);
    const base = overridesDefinition(detail, state);

    await binding.writerFor('access')(
      'hash-0',
      written(base, { tools: ['lookup-order', 'issue-refund'] }),
      filledWith(base),
    );

    expect(bodies[0]?.['overrides']).toEqual({
      instructions: 'X',
      model: 'anthropic/haiku',
      tools: ['lookup-order', 'issue-refund'],
    });
  });
});
