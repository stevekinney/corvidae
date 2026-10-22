/**
 * COR-1559 — a `model` steering override names its provider beside its model, and a stale
 * `expectedRevision` has a reason of its own. The gate keeps the model's provider apart from the
 * `provider` target, so a provider command never rewrites it.
 */
import { describe, expect, it } from 'bun:test';

import { createSteeringGate, type ImplementedSteeringCommand } from './steering';

const NOW = '2026-10-22T00:00:01.000Z';

function modelCommand(
  id: string,
  override: string,
  provider?: string,
  extra: Partial<ImplementedSteeringCommand> = {},
): ImplementedSteeringCommand {
  return {
    id,
    idOrigin: 'caller',
    sessionId: 'session-1',
    principal: 'alice',
    requestedValue: {
      target: 'model',
      override,
      ...(provider === undefined ? {} : { provider }),
    },
    requestedAt: '2026-10-22T00:00:00.000Z',
    ...extra,
  };
}

describe('a model override that names its provider', () => {
  it('is desired state beside the model, and leaves the provider target alone', () => {
    const gate = createSteeringGate('session-1');

    const outcome = gate.admit(modelCommand('c1', 'claude-opus-5-5', 'openai'), {
      liveRunIds: [],
      now: NOW,
    });

    expect(outcome.outcome).toBe('accepted');
    const desired = gate.getDesiredState();
    expect(desired.model).toBe('claude-opus-5-5');
    expect(desired.modelProvider).toBe('openai');
    expect(desired.provider).toBeUndefined();
  });

  it('keeps a provider-less override provider-unspecified', () => {
    const gate = createSteeringGate('session-1');

    gate.admit(modelCommand('c1', 'claude-opus-5-5'), { liveRunIds: [], now: NOW });

    const desired = gate.getDesiredState();
    expect(desired.model).toBe('claude-opus-5-5');
    expect(desired.modelProvider).toBeUndefined();
  });

  it('clears the provider a later provider-less override replaces', () => {
    const gate = createSteeringGate('session-1');
    gate.admit(modelCommand('c1', 'claude-opus-5-5', 'openai'), { liveRunIds: [], now: NOW });

    gate.admit(modelCommand('c2', 'claude-opus-5'), { liveRunIds: [], now: NOW });

    expect(gate.getDesiredState().model).toBe('claude-opus-5');
    expect(gate.getDesiredState().modelProvider).toBeUndefined();
  });

  it('treats the same model under another provider as a different value, not an idempotent repeat', () => {
    const gate = createSteeringGate('session-1');
    const first = gate.admit(modelCommand('c1', 'claude-opus-5-5', 'anthropic'), {
      liveRunIds: [],
      now: NOW,
    });
    const second = gate.admit(modelCommand('c2', 'claude-opus-5-5', 'openai'), {
      liveRunIds: [],
      now: NOW,
    });

    expect(first.outcome === 'accepted' && second.outcome === 'accepted').toBe(true);
    if (first.outcome !== 'accepted' || second.outcome !== 'accepted') return;
    expect(second.command.configVersion).toBe(first.command.configVersion + 1);
    expect(gate.getDesiredState().modelProvider).toBe('openai');
  });

  it('is idempotent at the value only when the provider matches too', () => {
    const gate = createSteeringGate('session-1');
    const first = gate.admit(modelCommand('c1', 'claude-opus-5-5', 'openai'), {
      liveRunIds: [],
      now: NOW,
    });
    const repeat = gate.admit(modelCommand('c2', 'claude-opus-5-5', 'openai'), {
      liveRunIds: [],
      now: NOW,
    });

    expect(first.outcome === 'accepted' && repeat.outcome === 'accepted').toBe(true);
    if (first.outcome !== 'accepted' || repeat.outcome !== 'accepted') return;
    expect(repeat.command.configVersion).toBe(first.command.configVersion);
  });

  it('answers a retry of the same id under another provider as a conflict', () => {
    const gate = createSteeringGate('session-1');
    gate.admit(modelCommand('c1', 'claude-opus-5-5', 'anthropic'), { liveRunIds: [], now: NOW });

    const retry = gate.admit(modelCommand('c1', 'claude-opus-5-5', 'openai'), {
      liveRunIds: [],
      now: NOW,
    });

    expect(retry.outcome).toBe('conflict');
    expect(
      gate.admit(modelCommand('c1', 'claude-opus-5-5', 'anthropic'), { liveRunIds: [], now: NOW })
        .outcome,
    ).toBe('replayed');
  });

  it('is visible to a run that is already in flight', () => {
    const gate = createSteeringGate('session-1');
    gate.promoteForNewRun('run-1');

    gate.admit(modelCommand('c1', 'claude-opus-5-5', 'openai'), {
      liveRunIds: ['run-1'],
      now: NOW,
    });

    const seen = gate.forRun('run-1').getDesiredState();
    expect(seen.model).toBe('claude-opus-5-5');
    expect(seen.modelProvider).toBe('openai');
  });
});

describe('a stale expectedRevision', () => {
  it('is rejected with stale-revision, not policy-denied', () => {
    const gate = createSteeringGate('session-1');
    gate.admit(modelCommand('c1', 'claude-opus-5-5', 'anthropic'), { liveRunIds: [], now: NOW });

    const outcome = gate.admit(
      modelCommand('c2', 'claude-opus-5', 'anthropic', { expectedRevision: 0 }),
      { liveRunIds: [], now: NOW },
    );

    expect(outcome).toEqual({
      outcome: 'rejected',
      failure: { failedAt: NOW, reason: 'stale-revision' },
    });
    expect(gate.getDesiredState().model).toBe('claude-opus-5-5');
  });

  it('is admitted when it names the current version', () => {
    const gate = createSteeringGate('session-1');
    const first = gate.admit(modelCommand('c1', 'claude-opus-5-5', 'anthropic'), {
      liveRunIds: [],
      now: NOW,
    });
    if (first.outcome !== 'accepted') throw new Error('expected accepted');

    const outcome = gate.admit(
      modelCommand('c2', 'claude-opus-5', 'anthropic', {
        expectedRevision: first.command.configVersion,
      }),
      { liveRunIds: [], now: NOW },
    );

    expect(outcome.outcome).toBe('accepted');
  });
});
