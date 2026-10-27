/**
 * COR-837 — A2UI surfaces are the AG-UI stream's second source. A surface created on a run's task
 * reaches that run's stream as an `ACTIVITY_SNAPSHOT` (`activityType: 'a2ui-surface'`, the surface
 * id as `messageId`) for a client that opted in, on the holder's stream and on a peer's, in the
 * opening of an attach and as a live change; a client that did not opt in sees none. The mount is
 * the real one over a real SQLite-backed Bureau, so the task id being the native run id is proved
 * here rather than assumed.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it, spyOn } from 'bun:test';

import {
  confirmAction,
  createMessage,
  panelComponents,
  updateComponentsMessage,
} from '../a2ui/a2ui.test-support.ts';
import { INTERACTIVE_SURFACE_CONTRACT_VERSION } from '../interactive-surface/types.ts';
import { createA2uiAdapter } from '../a2ui/adapter.ts';
import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_CINDER_CATALOG_ID,
  A2UI_EXTENSION_URI,
} from '../a2ui/catalogs.ts';
import {
  attachRunRequest,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { bureauMetadata, FrameReader, type ReceivedFrame } from './ag-ui-stream.test-support.ts';

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});
const hold = { kind: 'block' as const, barrier: 'hold' };
const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

const OPT_IN = {
  a2uiClientCapabilities: { 'v0.9': { supportedCatalogIds: [A2UI_BASIC_CATALOG_ID] } },
};

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await openHarness({
    script: [hold, say('done')],
    storage: 'sqlite',
    durableOwnership: OWNERSHIP,
  });
  try {
    await body(harness);
  } finally {
    await harness.dispose();
  }
}

/** Starts the run, reads to its first `STATE_SNAPSHOT`, and holds it open. */
async function startHeld(
  harness: Harness,
  forwardedProps: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ readonly reader: FrameReader; readonly taskId: string }> {
  const reader = new FrameReader(
    await harness.handler(startRequest(runAgentInput({ forwardedProps }), headers)),
  );
  const started = await reader.until(EventType.STATE_SNAPSHOT);
  await harness.generate.reached('hold');
  const taskId = String(bureauMetadata(started[0]!.event)['runId']);
  return { reader, taskId };
}

async function propose(
  harness: Harness,
  taskId: string,
  options: {
    readonly commandId: string;
    readonly baseRevision?: number;
    readonly messages?: unknown[];
    readonly surfaceId?: string;
  },
) {
  const surfaces = harness.bureau.surfaces;
  if (surfaces === undefined) throw new Error('a persistent Bureau has surfaces');
  const record = await harness.bureau.internals.taskRegistry.record(taskId);
  if (record === undefined) throw new Error('the run is a task with a record');
  const surfaceId = options.surfaceId ?? 'panel';
  const receipt = await createA2uiAdapter({ surfaces }).apply(
    {
      taskId,
      commandId: options.commandId,
      messages: options.messages ?? [
        createMessage(surfaceId),
        updateComponentsMessage(surfaceId, panelComponents()),
      ],
      actions: [
        {
          ...confirmAction,
          continuation: { type: 'signal', sessionId: record.contextId, signalName: 'confirmed' },
        },
      ],
      ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
    },
    { principal: record.owner },
  );
  expect(receipt.outcome).toBe('accepted');
}

type Activity = {
  messageId: string;
  activityType: string;
  replace?: boolean;
  content: {
    surfaceId: string;
    surfaceRevision: number;
    messages: Array<Record<string, unknown>>;
  };
};

const activityOf = (frames: ReadonlyArray<ReceivedFrame>): Activity[] =>
  frames
    .filter((frame) => frame.event.type === EventType.ACTIVITY_SNAPSHOT)
    .map((frame) => frame.event as unknown as Activity);

/** Reads to the next surface snapshot and returns it. */
async function nextActivity(reader: FrameReader): Promise<Activity> {
  const read = await reader.until(EventType.ACTIVITY_SNAPSHOT);
  const [snapshot] = activityOf(read.slice(-1));
  if (snapshot === undefined) throw new Error('no surface snapshot');
  return snapshot;
}

describe('A2UI surfaces on the AG-UI stream', () => {
  it('sends a surface created on the run’s task, and each change, to a client that opted in', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness, OPT_IN);
      // The task id is the native run id: a surface created on it shows up on this stream.
      await propose(harness, taskId, { commandId: 'create' });
      const first = await nextActivity(reader);
      expect(first).toMatchObject({
        messageId: 'panel',
        activityType: 'a2ui-surface',
        replace: true,
        content: { surfaceId: 'panel', surfaceRevision: 1, liveness: 'live' },
      });
      expect(first.content.messages.map((message) => Object.keys(message)[1])).toEqual([
        'createSurface',
        'updateComponents',
        'updateDataModel',
      ]);

      await propose(harness, taskId, {
        commandId: 'update',
        baseRevision: 1,
        messages: [
          {
            version: 'v0.9.1',
            updateDataModel: { surfaceId: 'panel', path: '/note', value: 'later' },
          },
        ],
      });
      const second = await nextActivity(reader);
      expect(second.content.surfaceRevision).toBe(2);

      harness.generate.release('hold');
      const rest = await reader.rest();
      expect(rest.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
    });
  });

  it('sends nothing to a client that did not opt in', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness);
      await propose(harness, taskId, { commandId: 'create' });
      harness.generate.release('hold');
      const rest = await reader.rest();
      expect(
        [...reader.received, ...rest].some((f) => f.event.type === EventType.ACTIVITY_SNAPSHOT),
      ).toBe(false);
    });
  });

  it('opens an attach with the surfaces as they stand, when the attach declares support in a header', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness);
      await propose(harness, taskId, { commandId: 'create' });

      const plain = new FrameReader(await harness.handler(attachRunRequest(taskId)));
      await plain.until(EventType.STATE_SNAPSHOT);

      const attached = new FrameReader(
        await harness.handler(attachRunRequest(taskId, { 'x-a2a-extensions': A2UI_EXTENSION_URI })),
      );
      const opening = await attached.until(EventType.ACTIVITY_SNAPSHOT);
      expect(opening.map((frame) => frame.event.type).slice(-2)).toEqual([
        EventType.STATE_SNAPSHOT,
        EventType.ACTIVITY_SNAPSHOT,
      ]);
      expect(activityOf(opening.slice(-1))[0]!.content.surfaceRevision).toBe(1);

      harness.generate.release('hold');
      const plainRest = await plain.rest();
      expect(
        [...plain.received, ...plainRest].some((f) => f.event.type === EventType.ACTIVITY_SNAPSHOT),
      ).toBe(false);
      await reader.rest();
      await attached.rest();
    });
  });

  it('offers a surface only in a catalog the client listed', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness);
      await propose(harness, taskId, { commandId: 'create' });

      const cinderOnly = new FrameReader(
        await harness.handler(
          attachRunRequest(taskId, {
            'x-a2ui-client-capabilities': JSON.stringify({
              'v0.9': { supportedCatalogIds: [A2UI_CINDER_CATALOG_ID] },
            }),
          }),
        ),
      );
      await cinderOnly.until(EventType.STATE_SNAPSHOT);
      const listsBasic = new FrameReader(
        await harness.handler(
          attachRunRequest(taskId, {
            'x-a2ui-client-capabilities': JSON.stringify({
              'v0.9': { supportedCatalogIds: [A2UI_BASIC_CATALOG_ID, A2UI_CINDER_CATALOG_ID] },
            }),
          }),
        ),
      );
      await listsBasic.until(EventType.ACTIVITY_SNAPSHOT);

      harness.generate.release('hold');
      const cinderRest = await cinderOnly.rest();
      expect(
        [...cinderOnly.received, ...cinderRest].some(
          (f) => f.event.type === EventType.ACTIVITY_SNAPSHOT,
        ),
      ).toBe(false);
      await listsBasic.rest();
      await reader.rest();
    });
  });

  it('sends a peer’s attach the surfaces of a run another process holds', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness);
      await propose(harness, taskId, { commandId: 'create' });
      const peer = await harness.peer([]);
      try {
        const attached = new FrameReader(
          await peer.handler(attachRunRequest(taskId, { 'x-a2a-extensions': A2UI_EXTENSION_URI })),
        );
        const opening = await attached.until(EventType.ACTIVITY_SNAPSHOT);
        expect(activityOf(opening.slice(-1))[0]).toMatchObject({
          messageId: 'panel',
          content: { surfaceRevision: 1 },
        });
        harness.generate.release('hold');
        await reader.rest();
        const tail = await attached.rest();
        expect(tail.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
      } finally {
        await peer.dispose();
      }
    });
  });
  it('tells the client to drop a surface that was closed', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness, OPT_IN);
      await propose(harness, taskId, { commandId: 'create' });
      await reader.until(EventType.ACTIVITY_SNAPSHOT);
      const closed = await harness.bureau.surfaces!.close(
        {
          type: 'surface.close',
          contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
          commandId: 'close',
          taskId,
          surfaceId: 'panel',
          baseRevision: 1,
          reason: 'dismissed',
        },
        { principal: (await harness.bureau.internals.taskRegistry.record(taskId))!.owner },
      );
      expect(closed.outcome).toBe('accepted');
      const gone = await nextActivity(reader);
      expect(gone.content.messages.map((message) => Object.keys(message)[1])).toEqual([
        'deleteSurface',
      ]);
      harness.generate.release('hold');
      await reader.rest();
    });
  });
  it('treats a malformed capabilities header as no opt-in', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness);
      await propose(harness, taskId, { commandId: 'create' });
      const attached = new FrameReader(
        await harness.handler(
          attachRunRequest(taskId, { 'x-a2ui-client-capabilities': 'not json' }),
        ),
      );
      await attached.until(EventType.STATE_SNAPSHOT);
      harness.generate.release('hold');
      const rest = await attached.rest();
      expect(
        [...attached.received, ...rest].some((f) => f.event.type === EventType.ACTIVITY_SNAPSHOT),
      ).toBe(false);
      await reader.rest();
    });
  });

  it('leaves no subscription behind when the client goes away during the opening read', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness);
      const live = new Set<object>();
      const subscribe = harness.bureau.subscribeEventHistory.bind(harness.bureau);
      const subscribeSpy = spyOn(harness.bureau, 'subscribeEventHistory').mockImplementation(
        (...args: Parameters<typeof subscribe>) => {
          const subscription = subscribe(...args);
          live.add(subscription);
          return {
            ...subscription,
            unsubscribe: () => {
              live.delete(subscription);
              subscription.unsubscribe();
            },
          };
        },
      );
      const history = harness.bureau.eventHistory.bind(harness.bureau);
      let reading: (() => void) | undefined;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readSpy = spyOn(harness.bureau, 'eventHistory').mockImplementation(
        async (...args: Parameters<typeof history>) => {
          reading?.();
          await gate;
          return history(...args);
        },
      );
      try {
        const reached = new Promise<void>((resolve) => {
          reading = resolve;
        });
        const attached = new FrameReader(
          await harness.handler(
            attachRunRequest(taskId, { 'x-a2a-extensions': A2UI_EXTENSION_URI }),
          ),
        );
        await reached;
        await attached.cancel();
        release();
        await Bun.sleep(50);
        expect(live.size).toBe(0);
      } finally {
        release();
        readSpy.mockRestore();
        subscribeSpy.mockRestore();
      }
      harness.generate.release('hold');
      await reader.rest();
    });
  });
  it('delivers a surface created after a peer’s attach opened, while the run is still going', async () => {
    await withHarness(async (harness) => {
      const { reader, taskId } = await startHeld(harness);
      const peer = await harness.peer([]);
      try {
        const attached = new FrameReader(
          await peer.handler(attachRunRequest(taskId, { 'x-a2a-extensions': A2UI_EXTENSION_URI })),
        );
        await attached.until(EventType.STATE_SNAPSHOT);
        await propose(harness, taskId, { commandId: 'create' });
        const live = await nextActivity(attached);
        expect(live.content.surfaceRevision).toBe(1);
        harness.generate.release('hold');
        await reader.rest();
        await attached.rest();
      } finally {
        await peer.dispose();
      }
    });
  });
});
