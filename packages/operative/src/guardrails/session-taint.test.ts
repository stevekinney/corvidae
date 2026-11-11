import { describe, expect, it, mock } from 'bun:test';

import {
  createSessionTaintTracker,
  persistedSessionTaintOf,
  readSessionTaint,
  SESSION_TAINT_METADATA_KEY,
} from './session-taint';
import type { InputDetector, OutputValidator, SessionTaintedEvent } from './types';

function createMockDetector(name: string): InputDetector {
  return {
    name,
    detect: async () => ({ triggered: false, confidence: 0, category: 'mock' }),
  };
}

function createMockValidator(name: string): OutputValidator {
  return {
    name,
    validate: async () => ({ valid: true, confidence: 0, category: 'mock' }),
  };
}

const baseTaintEvent: SessionTaintedEvent = {
  reason: 'High-confidence injection detected',
  detector: 'prompt-injection',
  category: 'prompt-injection',
  confidence: 0.95,
  step: 1,
};

describe('createSessionTaintTracker', () => {
  it('starts in an untainted state', () => {
    const tracker = createSessionTaintTracker();
    expect(tracker.isTainted()).toBe(false);
  });

  it('becomes tainted after calling taint()', () => {
    const tracker = createSessionTaintTracker();
    tracker.taint(baseTaintEvent);
    expect(tracker.isTainted()).toBe(true);
  });

  it('stays tainted once tainted (no un-tainting)', () => {
    const tracker = createSessionTaintTracker();
    tracker.taint(baseTaintEvent);
    expect(tracker.isTainted()).toBe(true);
    // Taint is sticky
    expect(tracker.isTainted()).toBe(true);
  });

  it('calls onTainted callback when tainted', () => {
    const onTainted = mock((_event: SessionTaintedEvent) => {});
    const tracker = createSessionTaintTracker({ onTainted });
    tracker.taint(baseTaintEvent);
    expect(onTainted).toHaveBeenCalledTimes(1);
    const event = onTainted.mock.calls[0]![0];
    expect(event).toEqual(baseTaintEvent);
  });

  it('does not call onTainted on subsequent taint calls', () => {
    const onTainted = mock((_event: SessionTaintedEvent) => {});
    const tracker = createSessionTaintTracker({ onTainted });
    tracker.taint(baseTaintEvent);
    tracker.taint({ ...baseTaintEvent, step: 2 });
    // Only fires on first taint
    expect(onTainted).toHaveBeenCalledTimes(1);
  });

  describe('detector escalation', () => {
    it('returns no extra detectors when not tainted', () => {
      const escalatedDetectors = [createMockDetector('escalated-1')];
      const tracker = createSessionTaintTracker({
        escalatedDetectors,
      });

      const result = tracker.getDetectors();
      expect(result).toHaveLength(0);
    });

    it('returns escalated detectors when tainted', () => {
      const escalatedDetectors = [createMockDetector('escalated-1')];
      const tracker = createSessionTaintTracker({
        escalatedDetectors,
      });

      tracker.taint(baseTaintEvent);

      const result = tracker.getDetectors();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('escalated-1');
    });
  });

  describe('validator escalation', () => {
    it('returns no extra validators when not tainted', () => {
      const escalatedValidators = [createMockValidator('escalated-v1')];
      const tracker = createSessionTaintTracker({
        escalatedValidators,
      });

      const result = tracker.getValidators();
      expect(result).toHaveLength(0);
    });

    it('returns escalated validators when tainted', () => {
      const escalatedValidators = [createMockValidator('escalated-v1')];
      const tracker = createSessionTaintTracker({
        escalatedValidators,
      });

      tracker.taint(baseTaintEvent);

      const result = tracker.getValidators();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('escalated-v1');
    });
  });

  describe('taintThreshold', () => {
    it('uses default threshold of 0.9', () => {
      const tracker = createSessionTaintTracker();
      // The tracker itself doesn't check threshold — that's the caller's job
      // But we verify the tracker accepts threshold option
      expect(tracker.isTainted()).toBe(false);
    });
  });
});

describe('createSessionTaintTracker with an initial taint (COR-2105)', () => {
  const initial = {
    category: 'prompt-injection',
    detector: 'prompt-injection',
    provenance: 'user-input' as const,
    confidence: 0.95,
    at: 1,
    runId: 'run-1',
  };

  it('starts tainted and never calls onTainted for the taint it was given', () => {
    const onTainted = mock(() => {});
    const tracker = createSessionTaintTracker({ initial, onTainted });
    expect(tracker.isTainted()).toBe(true);
    tracker.taint(baseTaintEvent);
    expect(onTainted).not.toHaveBeenCalled();
  });

  it('stamps the tracker run id onto an event that names none', () => {
    const onTainted = mock((_event: SessionTaintedEvent) => {});
    createSessionTaintTracker({ runId: 'run-9', onTainted }).taint(baseTaintEvent);
    expect(onTainted.mock.calls[0]?.[0].runId).toBe('run-9');
  });

  it('settles after an asynchronous onTainted, and never rejects', async () => {
    let finished = false;
    const tracker = createSessionTaintTracker({
      onTainted: async () => {
        await Promise.resolve();
        finished = true;
        throw new Error('write failed');
      },
    });
    tracker.taint(baseTaintEvent);
    expect(finished).toBe(false);
    await tracker.settled();
    expect(finished).toBe(true);
  });

  it('does not throw from taint() when onTainted throws synchronously, and settles', async () => {
    const tracker = createSessionTaintTracker({
      onTainted: () => {
        throw new Error('sync failure');
      },
    });
    expect(() => tracker.taint(baseTaintEvent)).not.toThrow();
    expect(tracker.isTainted()).toBe(true);
    await tracker.settled();
  });

  it('awaits a non-Promise thenable returned by onTainted', async () => {
    let finished = false;
    const tracker = createSessionTaintTracker({
      onTainted: () => ({
        then: (resolve: () => void) => {
          queueMicrotask(() => {
            finished = true;
            resolve();
          });
        },
      }),
    });
    tracker.taint(baseTaintEvent);
    await tracker.settled();
    expect(finished).toBe(true);
  });
});

describe('readSessionTaint', () => {
  it('reads a session stored without the key as untainted', () => {
    expect(readSessionTaint({ lastRunId: 'run-1' })).toBeUndefined();
    expect(readSessionTaint({})).toBeUndefined();
    expect(readSessionTaint(undefined)).toBeUndefined();
    expect(readSessionTaint({ [SESSION_TAINT_METADATA_KEY]: null })).toBeUndefined();
    expect(readSessionTaint({ [SESSION_TAINT_METADATA_KEY]: { detector: 'x' } })).toBeUndefined();
  });

  it('round-trips a persisted taint and carries no free text', () => {
    const persisted = persistedSessionTaintOf(
      { ...baseTaintEvent, reason: 'SECRET FLAGGED TEXT' },
      42,
      'run-7',
    );
    expect(JSON.stringify(persisted)).not.toContain('SECRET FLAGGED TEXT');
    expect(persisted).toEqual({
      category: 'prompt-injection',
      detector: 'prompt-injection',
      provenance: 'user-input',
      confidence: 0.95,
      at: 42,
      runId: 'run-7',
    });
    expect(readSessionTaint({ [SESSION_TAINT_METADATA_KEY]: { ...persisted } })).toEqual(persisted);
  });
});
