import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { DetectorContext, GuardrailProvenance, InputDetector } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { getEventListeners } from 'node:events';

import {
  type GovernedContentScanOptions,
  scanGovernedContent,
} from '../../src/governance/content-scan';
import { createGovernedFixture, principalA, recordIdOf } from './governed-memory-harness';

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
      detector: 'loud',
      category: 'poison',
      confidence: 0.8,
    });
    expect(seen).toEqual(['ingested-document']);
  });

  it('fails closed when a detector throws', async () => {
    expect(await scan('fact', [broken, quiet], 'recalled-memory')).toEqual({
      flagged: true,
      detector: 'broken',
      category: 'detector-failure',
      confidence: 1,
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
