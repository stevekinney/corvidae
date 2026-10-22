/**
 * A launching start's marker is settled through the record that launch made, never through its id
 * alone (COR-1625). A worker launch that awaited while a `start-new` replacement recorded its own
 * marker under the same id must leave that marker, or a reclaim replays the replacement while it is
 * still launching.
 */
import { describe, expect, it } from 'bun:test';

import type { EngineInternals } from './internals.ts';
import {
  handOverPendingLaunch,
  letGoOfPendingLaunch,
  recordLaunchPending,
} from './local-execution.ts';

const WORKFLOW_ID = 'launching-run';

/** Only the fields the marker bookkeeping reads. A worker engine has no inline strategy. */
function createMarkerInternals(inlineStrategy: unknown = null): EngineInternals {
  return {
    queuedOrLaunchingInlineWorkflowStartIds: new Set<string>(),
    queuedInlineWorkflowStartIds: new Set<string>(),
    inlineStrategy,
    workflowClaimRegistry: null,
  } as never;
}

describe('a worker launch handing its run over', () => {
  it('settles its own marker', () => {
    const internals = createMarkerInternals();
    const launch = recordLaunchPending(internals, WORKFLOW_ID);
    handOverPendingLaunch(internals, launch);
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(false);
  });

  it("leaves a same-id replacement's marker, which only the replacement settles", async () => {
    const internals = createMarkerInternals();
    const original = recordLaunchPending(internals, WORKFLOW_ID);
    const replacement = recordLaunchPending(internals, WORKFLOW_ID);

    handOverPendingLaunch(internals, original);
    await letGoOfPendingLaunch(internals, original);
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(true);

    handOverPendingLaunch(internals, replacement);
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(false);
  });

  it('settles nothing for a launch that set no marker', () => {
    const internals = createMarkerInternals();
    recordLaunchPending(internals, WORKFLOW_ID);
    handOverPendingLaunch(internals, undefined);
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(true);
  });
});

describe('an inline launch handing its run over', () => {
  it('leaves the marker to the queue that took it over', () => {
    const internals = createMarkerInternals({});
    const launch = recordLaunchPending(internals, WORKFLOW_ID);
    handOverPendingLaunch(internals, launch);
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(true);
  });
});
