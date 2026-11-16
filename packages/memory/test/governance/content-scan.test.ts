import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { DetectorContext, GuardrailProvenance, InputDetector } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { getEventListeners } from 'node:events';

import {
  type GovernedContentScanOptions,
  scanGovernedContent,
} from '../../src/governance/content-scan';
import type { TextSearchProvider } from '../../src/text-search-provider';
import {
  authority,
  createGovernedFixture,
  principalA,
  recordIdOf,
} from './governed-memory-harness';

const quiet: InputDetector = {
  name: 'quiet',
  detect: async () => ({ triggered: false, confidence: 0, category: 'none' }),
};
const loud: InputDetector = {
  name: 'loud',
  detect: async () => ({ triggered: true, confidence: 0.8, category: 'poison', detail: 'x' }),
};
const broken: InputDetector = {
  name: 'broken',
  detect: async () => {
    throw new Error('detector offline');
  },
};

const MEMORY = { source: 'conversation', memoryClass: 'episodic', trust: 'untrusted' } as const;

/** `scanGovernedContent` over a record of the usual kind, for a test that is not about the record. */
function scan(
  content: string,
  detectors: readonly InputDetector[],
  provenance: GuardrailProvenance,
  options?: GovernedContentScanOptions,
) {
  return scanGovernedContent(content, detectors, provenance, MEMORY, options);
}

describe('scanGovernedContent', () => {
  it('reports clean content', async () => {
    expect(await scan('fact', [quiet], 'user-input')).toEqual({ flagged: false });
  });

  it('reports the first detector that trips, without the content', async () => {
    const seen: string[] = [];
    const spy: InputDetector = {
      name: 'spy',
      detect: async (_input, context) => {
        seen.push(context.provenance);
        return { triggered: false, confidence: 0, category: 'none' };
      },
    };
    expect(await scan('fact', [spy, loud, broken], 'ingested-document')).toEqual({
      flagged: true,
      failed: false,
      detector: 'loud',
      category: 'poison',
      confidence: 0.8,
    });
    expect(seen).toEqual(['ingested-document']);
  });

  it('fails closed when a detector throws, and says it failed', async () => {
    expect(await scan('fact', [broken, quiet], 'recalled-memory')).toEqual({
      flagged: true,
      failed: true,
      detector: 'broken',
      category: 'detector-failure',
      confidence: 1,
    });
  });

  it('does not call a detector’s own `detector-failure` category a failure (COR-2194)', async () => {
    const reporting: InputDetector = {
      name: 'reporting',
      detect: async () => ({ triggered: true, confidence: 0.5, category: 'detector-failure' }),
    };
    expect(await scan('fact', [reporting], 'recalled-memory')).toEqual({
      flagged: true,
      failed: false,
      detector: 'reporting',
      category: 'detector-failure',
      confidence: 0.5,
    });
  });
});

/** COR-2193: the operation's signal reaches every detector, and a cancelled scan stops waiting. */
describe('scanGovernedContent cancellation', () => {
  /** A detector that calls `started`, then never settles. */
  function hanging(started: () => void): InputDetector {
    return {
      name: 'hanging',
      detect: () => {
        started();
        return new Promise(() => undefined);
      },
    };
  }

  it('hands each detector the operation’s signal, and none when there is none', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const spy: InputDetector = {
      name: 'spy',
      detect: async (_input, context) => {
        seen.push(context.signal);
        return { triggered: false, confidence: 0, category: 'none' };
      },
    };
    const controller = new AbortController();
    await scan('fact', [spy, spy], 'recalled-memory', { signal: controller.signal });
    await scan('fact', [spy], 'recalled-memory');
    expect(seen).toEqual([controller.signal, controller.signal, undefined]);
  });

  it('runs no detector once the signal has aborted, and rejects with its reason', async () => {
    const ran: string[] = [];
    const spy: InputDetector = {
      name: 'spy',
      detect: async () => {
        ran.push('spy');
        return { triggered: false, confidence: 0, category: 'none' };
      },
    };
    const reason = new Error('stop');
    const controller = new AbortController();
    controller.abort(reason);
    expect(
      await rejectionOf(scan('fact', [spy], 'recalled-memory', { signal: controller.signal })),
    ).toBe(reason);
    expect(ran).toEqual([]);
  });

  it('rejects with the reason when the signal aborts during a detector that never settles, and removes its listener', async () => {
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => (started = resolve));
    const controller = new AbortController();
    const outcome = rejectionOf(
      scan('fact', [hanging(started)], 'recalled-memory', { signal: controller.signal }),
    );
    await hasStarted;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    const reason = new Error('canceled while scanning');
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes its listener once a detector settles', async () => {
    const controller = new AbortController();
    await scan('fact', [quiet, quiet], 'recalled-memory', { signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('counts a detector that throws while the signal is aborted as cancellation, never as a failure', async () => {
    const controller = new AbortController();
    const reason = new Error('canceled');
    const throwing: InputDetector = {
      name: 'throwing',
      detect: async () => {
        controller.abort(reason);
        throw new Error('the detector gave up');
      },
    };
    expect(
      await rejectionOf(scan('fact', [throwing], 'recalled-memory', { signal: controller.signal })),
    ).toBe(reason);
  });

  it('tells the caller of each detector that runs, and of no other', async () => {
    const counted: string[] = [];
    const options = { onDetectorRun: () => counted.push('run') };
    await scan('fact', [quiet, quiet], 'recalled-memory', options);
    expect(counted).toEqual(['run', 'run']);

    counted.length = 0;
    // The scan stops at the first trip, so the detector after it never runs.
    await scan('fact', [quiet, loud, quiet], 'recalled-memory', options);
    expect(counted).toEqual(['run', 'run']);
  });
});

/** COR-2197: a recall in a tainted session tells every recall guardrail so; writes and promotion do not. */
describe('the session taint a detector is told', () => {
  function taintSpy(seen: boolean[]): InputDetector {
    return {
      name: 'taint-spy',
      detect: async (_input, context) => {
        seen.push(context.sessionTainted);
        return { triggered: false, confidence: 0, category: 'none' };
      },
    };
  }

  it('is false unless the caller gives the session’s taint', async () => {
    const seen: boolean[] = [];
    await scan('fact', [taintSpy(seen)], 'recalled-memory');
    await scan('fact', [taintSpy(seen)], 'recalled-memory', { sessionTainted: false });
    await scan('fact', [taintSpy(seen)], 'recalled-memory', { sessionTainted: true });
    expect(seen).toEqual([false, false, true]);
  });

  it('reaches every recall guardrail of a recall in a tainted session, and none of an untainted one', async () => {
    const seen: boolean[] = [];
    const fixture = await createGovernedFixture('in-memory', {
      policy: { recall: { detectors: [taintSpy(seen), { ...taintSpy(seen), name: 'second' }] } },
    });
    await fixture.memory.write(principalA, 'The build runs on Bun.', {
      collection: 'notes',
      source: 'conversation',
    });
    const recall = (sessionTainted?: boolean) =>
      fixture.memory.recallForModel(principalA, 'build', {
        collection: 'notes',
        ...(sessionTainted === undefined ? {} : { sessionTainted }),
      });

    await recall();
    expect(seen).toEqual([false, false]);
    seen.length = 0;
    await recall(true);
    expect(seen).toEqual([true, true]);
    seen.length = 0;
    await recall(false);
    expect(seen).toEqual([false, false]);
  });

  it('is never given to an admission or a promotion scan', async () => {
    const seen: boolean[] = [];
    const fixture = await createGovernedFixture('in-memory', {
      policy: { admission: { detectors: [taintSpy(seen)] } },
    });
    const id = await recordIdOf(
      fixture.memory.write(principalA, 'The build runs on Bun.', {
        collection: 'notes',
        source: 'conversation',
      }),
    );
    await fixture.memory.promote(principalA, { id, collection: 'notes' });
    expect(seen).toEqual([false, false]);
  });
});

/** COR-2196: a detector is told the record's source, class and trust at admission, recall and promotion. */
describe('the record a detector is told about', () => {
  /** Reads what each scan told it about the record. */
  function recording(seen: (DetectorContext['memory'] | undefined)[]): InputDetector {
    return {
      name: 'recording',
      detect: async (_input, context) => {
        seen.push(context.memory);
        return { triggered: false, confidence: 0, category: 'none' };
      },
    };
  }
  /** Not the defaults, so a test that finds them was told them by the record. */
  const RECORD = { source: 'tool-result', memoryClass: 'semantic', trust: 'verified' } as const;
  const policyFor = (seen: (DetectorContext['memory'] | undefined)[]) => ({
    admission: {
      detectors: [recording(seen)],
      sourceTrust: { 'tool-result': 'verified' as const },
    },
    recall: { detectors: [recording(seen)] },
  });

  it('is what the scan puts on the detector’s context', async () => {
    const seen: (DetectorContext['memory'] | undefined)[] = [];
    await scanGovernedContent('fact', [recording(seen)], 'user-input', RECORD);
    expect(seen).toEqual([RECORD]);
  });

  it('is told at admission', async () => {
    const seen: (DetectorContext['memory'] | undefined)[] = [];
    const fixture = await createGovernedFixture('in-memory', { policy: policyFor(seen) });
    await fixture.memory.write(principalA, 'The build runs on Bun.', {
      collection: 'notes',
      source: RECORD.source,
      memoryClass: RECORD.memoryClass,
    });
    expect(seen).toEqual([RECORD]);
  });

  it('is told at recall, from the recalled record', async () => {
    const seen: (DetectorContext['memory'] | undefined)[] = [];
    const fixture = await createGovernedFixture('in-memory', { policy: policyFor(seen) });
    await fixture.memory.write(principalA, 'The build runs on Bun.', {
      collection: 'notes',
      source: RECORD.source,
      memoryClass: RECORD.memoryClass,
    });
    seen.length = 0;
    const bundle = await fixture.memory.recallForModel(principalA, 'build', {
      collection: 'notes',
    });
    expect(bundle.evidence).toHaveLength(1);
    expect(seen).toEqual([RECORD]);
  });

  it('is told at promotion, from the source record', async () => {
    const seen: (DetectorContext['memory'] | undefined)[] = [];
    const fixture = await createGovernedFixture('in-memory', { policy: policyFor(seen) });
    const id = await recordIdOf(
      fixture.memory.write(principalA, 'The build runs on Bun.', {
        collection: 'notes',
        source: RECORD.source,
        memoryClass: RECORD.memoryClass,
      }),
    );
    seen.length = 0;
    await fixture.memory.promote(principalA, { id, collection: 'notes' });
    expect(seen[0]).toEqual(RECORD);
  });
});

/**
 * COR-2194: what a guardrail that fails does, by where it runs. At recall a failure withholds the
 * record from that recall and leaves it `active`, so a later recall scans it again; a guardrail that
 * trips still quarantines it. At admission and promotion a failure is still a detection.
 *
 * | guardrail                              | admission   | recall                      | promotion |
 * | -------------------------------------- | ----------- | --------------------------- | --------- |
 * | throws                                 | quarantined | withheld, record `active`   | rejected  |
 * | cancelled by the recall's signal       | n/a         | `canceled`, record `active` | n/a       |
 * | trips                                  | quarantined | quarantined                 | rejected  |
 * | trips with a category of its own naming | quarantined | quarantined                 | rejected  |
 */
describe('a guardrail that fails (COR-2194)', () => {
  const CONTENT = 'The build runs on Bun.';
  const inspector = authority({ capabilities: ['memory:get', 'memory:inspect'] });

  /** A text index that finds nothing and notes which entries were taken out of it. */
  function indexSpy(removed: string[]): TextSearchProvider {
    return {
      init: async () => undefined,
      close: async () => undefined,
      index: async () => undefined,
      remove: async (id) => {
        removed.push(id);
      },
      clear: async () => undefined,
      search: async () => new Map(),
    };
  }

  /** A recall guardrail whose behavior a test changes between recalls. */
  function switchable(behavior: { current: 'throw' | 'pass' }, calls: string[]): InputDetector {
    return {
      name: 'switchable',
      detect: async (input) => {
        calls.push(input);
        if (behavior.current === 'throw') throw new Error('detector offline: secret detail');
        return { triggered: false, confidence: 0, category: 'none' };
      },
    };
  }

  async function withRecallGuardrail(detector: InputDetector) {
    const removed: string[] = [];
    const fixture = await createGovernedFixture('in-memory', {
      policy: { recall: { detectors: [detector] } },
      governed: { textSearchProvider: indexSpy(removed) },
    });
    const id = await recordIdOf(
      fixture.memory.write(principalA, CONTENT, { collection: 'notes', source: 'conversation' }),
    );
    const recall = (options: { signal?: AbortSignal } = {}) =>
      fixture.memory.recallForModel(principalA, 'build', { collection: 'notes', ...options });
    const stateOf = async () => {
      const stored = await fixture.memory.get(inspector, { id, collection: 'notes' });
      return stored?.governance?.state;
    };
    const eventsOf = () => fixture.memory.listEvents(inspector, { type: 'memory.recall.withheld' });
    return { fixture, id, removed, recall, stateOf, eventsOf };
  }

  describe('at recall', () => {
    it('finds the record when no guardrail objects, so the rows below are about the guardrail', async () => {
      const { recall, stateOf, eventsOf } = await withRecallGuardrail(quiet);
      const bundle = await recall();
      expect(bundle.evidence).toHaveLength(1);
      expect(await stateOf()).toBe('active');
      expect(await eventsOf()).toEqual([]);
    });

    it('withholds a record whose guardrail throws, and leaves it active and in the index', async () => {
      const { id, removed, recall, stateOf, eventsOf } = await withRecallGuardrail(broken);
      const bundle = await recall();
      expect(bundle).toMatchObject({ evidence: [], withheld: 1, rendered: '' });
      expect(bundle.exclusions).toEqual([
        expect.objectContaining({
          recordId: id,
          reason: 'content-policy',
          detection: { detector: 'broken', category: 'detector-failure', confidence: 1 },
        }),
      ]);
      expect(await stateOf()).toBe('active');
      expect(removed).toEqual([]);
      const events = await eventsOf();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'memory.recall.withheld',
        outcome: 'withheld',
        reason: 'content-policy',
        recordIds: [id],
      });
      // Exactly these fields: no `failed` or `flagged`, and no error text.
      expect(events[0]?.diagnostic).toEqual({
        detector: 'broken',
        category: 'detector-failure',
        confidence: 1,
        contentDigest: expect.any(String),
      });
    });

    it('records and pushes no error text and no content for a guardrail that throws', async () => {
      const { eventsOf, fixture, recall } = await withRecallGuardrail(
        switchable({ current: 'throw' }, []),
      );
      const bundle = await recall();
      const everything = JSON.stringify([
        await eventsOf(),
        fixture.notifications,
        bundle.exclusions,
        bundle.rendered,
        bundle.stages,
      ]);
      expect(fixture.notifications.length).toBeGreaterThan(0);
      expect(everything).not.toContain('secret detail');
      expect(everything).not.toContain('offline');
      expect(everything).not.toContain(CONTENT);
    });

    it('scans the record again on a later recall, and recalls it once the guardrail answers', async () => {
      const behavior = { current: 'throw' as 'throw' | 'pass' };
      const calls: string[] = [];
      const { recall, stateOf, eventsOf } = await withRecallGuardrail(switchable(behavior, calls));

      const first = await recall();
      const second = await recall();
      expect([first.evidence, second.evidence]).toEqual([[], []]);
      expect(calls).toEqual([CONTENT, CONTENT]);
      expect(await eventsOf()).toHaveLength(2);

      behavior.current = 'pass';
      const healed = await recall();
      expect(healed.evidence).toHaveLength(1);
      expect(calls).toHaveLength(3);
      expect(await stateOf()).toBe('active');
    });

    it('ends as canceled when the signal cancels a guardrail, withholding and quarantining nothing', async () => {
      let started!: () => void;
      const hasStarted = new Promise<void>((resolve) => (started = resolve));
      const hangingDetector: InputDetector = {
        name: 'hanging',
        detect: () => {
          started();
          return new Promise(() => undefined);
        },
      };
      const { removed, recall, stateOf, eventsOf } = await withRecallGuardrail(hangingDetector);
      const controller = new AbortController();
      const pending = recall({ signal: controller.signal });
      await hasStarted;
      controller.abort(new Error('caller left'));
      const bundle = await pending;
      expect(bundle).toMatchObject({ evidence: [], stopReason: 'canceled' });
      expect(await stateOf()).toBe('active');
      expect(removed).toEqual([]);
      expect(await eventsOf()).toEqual([]);
    });

    it('does not count a guardrail that throws because the signal cancelled it as a failure', async () => {
      const controller = new AbortController();
      const throwing: InputDetector = {
        name: 'throwing',
        detect: async () => {
          controller.abort(new Error('caller left'));
          throw new Error('the guardrail gave up');
        },
      };
      const { recall, stateOf, eventsOf } = await withRecallGuardrail(throwing);
      expect(await recall({ signal: controller.signal })).toMatchObject({
        stopReason: 'canceled',
      });
      expect(await stateOf()).toBe('active');
      expect(await eventsOf()).toEqual([]);
    });

    it('still quarantines a record a guardrail trips on, and takes it out of the index', async () => {
      const { id, removed, recall, stateOf, eventsOf } = await withRecallGuardrail(loud);
      const bundle = await recall();
      expect(bundle).toMatchObject({ evidence: [], withheld: 1 });
      expect(await stateOf()).toBe('quarantined');
      expect(removed).toEqual([id]);
      expect(await eventsOf()).toEqual([
        expect.objectContaining({
          outcome: 'quarantined',
          reason: 'content-policy',
          diagnostic: {
            detector: 'loud',
            category: 'poison',
            confidence: 0.8,
            contentDigest: expect.any(String),
          },
        }),
      ]);
    });

    it('still quarantines when a guardrail that trips names its category `detector-failure`', async () => {
      const reporting: InputDetector = {
        name: 'reporting',
        detect: async () => ({ triggered: true, confidence: 0.5, category: 'detector-failure' }),
      };
      const { id, removed, recall, stateOf, eventsOf } = await withRecallGuardrail(reporting);
      await recall();
      expect(await stateOf()).toBe('quarantined');
      expect(removed).toEqual([id]);
      expect(await eventsOf()).toEqual([expect.objectContaining({ outcome: 'quarantined' })]);
    });
  });

  describe('at admission', () => {
    it('still quarantines a write whose guardrail throws', async () => {
      const fixture = await createGovernedFixture('in-memory', {
        policy: { admission: { detectors: [broken] } },
      });
      const receipt = await fixture.memory.write(principalA, CONTENT, {
        collection: 'notes',
        source: 'conversation',
      });
      expect(receipt.status).toBe('quarantined');
      const stored = await fixture.memory.get(inspector, {
        id: receipt.recordId!,
        collection: 'notes',
      });
      expect(stored?.governance?.state).toBe('quarantined');
      const [event] = await fixture.memory.listEvents(inspector, {
        type: 'memory.write.quarantined',
      });
      expect(event?.diagnostic).toEqual({
        detector: 'broken',
        category: 'detector-failure',
        confidence: 1,
        contentDigest: expect.any(String),
      });
    });

    it('still rejects a write whose guardrail throws when the policy rejects detections', async () => {
      const fixture = await createGovernedFixture('in-memory', {
        policy: { admission: { detectors: [broken], onDetection: 'reject' } },
      });
      expect(
        await fixture.memory.write(principalA, CONTENT, {
          collection: 'notes',
          source: 'conversation',
        }),
      ).toMatchObject({ status: 'rejected', reason: 'content-policy' });
    });
  });

  describe('at promotion', () => {
    it('still rejects a promotion whose guardrail throws, and leaves the source active', async () => {
      const behavior = { current: 'pass' as 'throw' | 'pass' };
      const fixture = await createGovernedFixture('in-memory', {
        policy: { admission: { detectors: [switchable(behavior, [])] } },
      });
      const id = await recordIdOf(
        fixture.memory.write(principalA, CONTENT, { collection: 'notes', source: 'conversation' }),
      );
      behavior.current = 'throw';
      expect(await fixture.memory.promote(principalA, { id, collection: 'notes' })).toMatchObject({
        status: 'rejected',
        reason: 'verification-failed',
      });
      const stored = await fixture.memory.get(inspector, { id, collection: 'notes' });
      expect(stored?.governance?.state).toBe('active');
      const [event] = await fixture.memory.listEvents(inspector, {
        type: 'memory.promotion.rejected',
      });
      expect(event?.diagnostic).toEqual({
        detector: 'switchable',
        category: 'detector-failure',
        confidence: 1,
        contentDigest: expect.any(String),
      });
    });
  });
});
