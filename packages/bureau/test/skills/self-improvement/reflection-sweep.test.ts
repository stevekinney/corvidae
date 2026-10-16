import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { reflectionSweep } from '../../../src/skills/self-improvement/reflection-sweep';
import type { StepResultLike } from '../../../src/skills/skill-memory';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function createMockMemory() {
  const entries: Array<{ content: string; metadata: Record<string, unknown> }> = [];
  return {
    entries,
    remember: mock(async (content: string, metadata?: Record<string, unknown>) => {
      entries.push({ content, metadata: metadata ?? {} });
      return {};
    }),
    recall: mock(async () => []),
  };
}

function createMockConversation(messages: Array<{ role: string; content: string }>) {
  return {
    getMessages() {
      return messages;
    },
  };
}

function createStepResult(overrides?: Partial<StepResultLike>): StepResultLike {
  return {
    step: 1,
    conversation: createMockConversation([
      { role: 'user', content: 'Help me refactor the auth module' },
      { role: 'assistant', content: 'I will break the refactor into three steps.' },
      { role: 'user', content: 'Sounds good, proceed.' },
      { role: 'assistant', content: 'Refactoring complete. All tests pass.' },
    ]),
    content: 'Refactoring complete. All tests pass.',
    final: true,
    metadata: {},
    ...overrides,
  };
}

// ── memory sink ───────────────────────────────────────────────────────────────

describe('reflectionSweep — memory sink', () => {
  let memory: ReturnType<typeof createMockMemory>;

  beforeEach(() => {
    memory = createMockMemory();
  });

  it('calls reflect with the run summary on the final step', async () => {
    const reflect = mock(async (summary: string) => `Insight: ${summary.slice(0, 30)}`);
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(createStepResult());

    expect(reflect).toHaveBeenCalledTimes(1);
    const calledWith = reflect.mock.calls[0]![0];
    expect(calledWith).toContain('## Run Summary');
    expect(calledWith).toContain('Initial query:');
  });

  it('uses an unknown initial query when there is no string user message', async () => {
    const reflect = mock(async (_runSummary: string) => 'insight');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(
      createStepResult({
        conversation: createMockConversation([
          { role: 'system', content: 'Follow the runbook.' },
          { role: 'assistant', content: 'I checked the runbook.' },
        ]),
      }),
    );

    expect(reflect.mock.calls[0]![0]).toContain('Initial query: (unknown)');
  });

  it('writes the insight to memory with experiential metadata', async () => {
    const reflect = mock(async () => 'Always run integration tests before refactoring auth.');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory, namespace: 'experiential' },
      reflect,
    });

    await onStep(createStepResult());

    expect(memory.remember).toHaveBeenCalledTimes(1);
    const { content, metadata } = memory.entries[0]!;
    expect(content).toBe('Always run integration tests before refactoring auth.');
    expect(metadata['source']).toBe('experiential');
    expect(metadata['namespace']).toBe('experiential');
    expect(metadata['tags']).toEqual(['strategy']);
  });

  it('defaults namespace to "experiential" when not specified', async () => {
    const reflect = mock(async () => 'insight');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(createStepResult());

    expect(memory.entries[0]!.metadata['namespace']).toBe('experiential');
  });

  it('forwards agentId and finishReason from step metadata', async () => {
    const reflect = mock(async () => 'agent-specific insight');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(
      createStepResult({ metadata: { agentId: 'refactor-agent', finishReason: 'stop' } }),
    );

    const { metadata } = memory.entries[0]!;
    expect(metadata['agentId']).toBe('refactor-agent');
    expect(metadata['finishReason']).toBe('stop');
  });

  it('is a no-op on non-final steps', async () => {
    const reflect = mock(async () => 'insight');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(memory.remember).not.toHaveBeenCalled();
  });

  it('is a no-op when shouldReflect returns false', async () => {
    const reflect = mock(async () => 'insight');
    const shouldReflect = mock((_: StepResultLike) => false);
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
      shouldReflect,
    });

    await onStep(createStepResult());

    expect(shouldReflect).toHaveBeenCalledTimes(1);
    expect(reflect).not.toHaveBeenCalled();
  });

  it('fires when shouldReflect returns true', async () => {
    const reflect = mock(async () => 'good insight');
    const shouldReflect = mock(() => true);
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
      shouldReflect,
    });

    await onStep(createStepResult());

    expect(reflect).toHaveBeenCalledTimes(1);
    expect(memory.entries).toHaveLength(1);
  });
});

// ── skill sink ────────────────────────────────────────────────────────────────

// ── soul sink ─────────────────────────────────────────────────────────────────

// ── persona sink ──────────────────────────────────────────────────────────────

// ── cross-sink: shouldReflect ─────────────────────────────────────────────────

// ── rejected pattern suppression ─────────────────────────────────────────────
//
// Regression for: PRRT_kwDORvupsc6MZErm
// rejectProposal() records a content hash to prevent re-proposal, but
// reflectionSweep did not check isRejectedPattern() before writing a fresh
// pending proposal. This section verifies the guard holds.

// ── proposal field integrity ──────────────────────────────────────────────────
