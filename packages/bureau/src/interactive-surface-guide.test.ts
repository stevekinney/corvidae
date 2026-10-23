/**
 * COR-1239 — the executable copy of the reconnect-and-reconstruct example in
 * `documentation/interactive-surface.md` ("Reconnecting and reconstructing a surface").
 *
 * The fold runs as written against a real run: a live stream and a second attach (the reconnect)
 * must hold the same surface, a stranger's attach holds none, and a closed surface is dropped. A
 * guard test compares the fold with the document's code block, so the two cannot drift: change
 * the example and the document together.
 */
import { EventType } from '@ag-ui/core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  confirmAction,
  createMessage,
  panelComponents,
  updateComponentsMessage,
} from './a2ui/a2ui.test-support.ts';
import { createA2uiAdapter } from './a2ui/adapter.ts';
import { A2UI_EXTENSION_URI } from './a2ui/catalogs.ts';
import {
  as,
  attachRunRequest,
  authentication,
  openHarness,
  runAgentInput,
  startRequest,
  type Harness,
} from './http/ag-ui-fixtures.test-support.ts';
import { bureauMetadata, FrameReader, readAgUiStream } from './http/ag-ui-stream.test-support.ts';
import { INTERACTIVE_SURFACE_CONTRACT_VERSION } from './interactive-surface/types.ts';

// Start of the document's example.
/** A JSON value, as an A2UI data model holds one. */
export type HeldJson = string | number | boolean | null | HeldJson[] | { [key: string]: HeldJson };

/** A component as `A2uiSurface` takes it: an `id` and a `component`, and its properties. */
export type HeldComponent = {
  readonly id: string;
  readonly component: string;
  readonly [property: string]: unknown;
};

/** What a client holds of one surface after folding its snapshots. */
export type HeldSurface = {
  readonly surfaceId: string;
  /** Keep this for the user's action: it is `a2uiSurfaceRevision` on the way back. */
  readonly surfaceRevision: number;
  readonly catalogId: string;
  readonly components: readonly HeldComponent[];
  readonly dataModel: HeldJson;
};

type SurfaceMessage = {
  createSurface?: { catalogId: string };
  updateComponents?: { components: HeldComponent[] };
  updateDataModel?: { value?: HeldJson };
  deleteSurface?: unknown;
};

/** Folds one AG-UI event into the surfaces a client holds. Anything but a surface snapshot is ignored. */
export function foldSurfaceEvent(
  held: Map<string, HeldSurface>,
  event: { type: string; activityType?: string; content?: unknown },
): void {
  if (event.type !== 'ACTIVITY_SNAPSHOT' || event.activityType !== 'a2ui-surface') return;
  const { surfaceId, surfaceRevision, messages } = event.content as {
    surfaceId: string;
    surfaceRevision: number;
    messages: SurfaceMessage[];
  };
  // A snapshot older than what the client holds changes nothing.
  const current = held.get(surfaceId);
  if (current !== undefined && surfaceRevision < current.surfaceRevision) return;
  let next: HeldSurface | undefined;
  for (const message of messages) {
    if (message.deleteSurface !== undefined) {
      held.delete(surfaceId);
      return;
    }
    if (message.createSurface !== undefined) {
      const { catalogId } = message.createSurface;
      next = { surfaceId, surfaceRevision, catalogId, components: [], dataModel: {} };
    } else if (next !== undefined && message.updateComponents !== undefined) {
      next = { ...next, components: message.updateComponents.components };
    } else if (next !== undefined && message.updateDataModel !== undefined) {
      // A snapshot always sets the whole model, at the root path.
      next = { ...next, dataModel: message.updateDataModel.value ?? {} };
    }
  }
  if (next !== undefined) held.set(surfaceId, next);
}
// End of the document's example.

const OPT_IN = { 'x-a2a-extensions': A2UI_EXTENSION_URI };
const hold = { kind: 'block' as const, barrier: 'hold' };
const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

async function withRun(
  body: (harness: Harness, taskId: string, stream: FrameReader) => Promise<void>,
): Promise<void> {
  const harness = await openHarness({
    script: [hold, say('done')],
    storage: 'sqlite',
    authentication,
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: 30_000,
      workflowClaimRenewIntervalMs: 25,
    },
  });
  try {
    // Alice starts the run and holds its stream open.
    const stream = new FrameReader(
      await harness.handler(startRequest(runAgentInput({}), as('alice-key'))),
    );
    const started = await stream.until(EventType.STATE_SNAPSHOT);
    await harness.generate.reached('hold');
    await body(harness, String(bureauMetadata(started[0]!.event)['runId']), stream);
  } finally {
    await harness.dispose();
  }
}

/** The agent proposes (or revises) a surface on the run's task, as the task's owner. */
async function propose(
  harness: Harness,
  taskId: string,
  commandId: string,
  baseRevision?: number,
): Promise<void> {
  const surfaces = harness.bureau.surfaces;
  const record = await harness.bureau.tasks.record(taskId);
  if (surfaces === undefined || record === undefined) throw new Error('a persistent Bureau run');
  const messages =
    baseRevision === undefined
      ? [createMessage('panel'), updateComponentsMessage('panel', panelComponents())]
      : [
          {
            version: 'v0.9.1',
            updateDataModel: { surfaceId: 'panel', path: '/note', value: 'later' },
          },
        ];
  const receipt = await createA2uiAdapter({ surfaces }).apply(
    {
      taskId,
      commandId,
      messages,
      actions: [
        {
          ...confirmAction,
          continuation: { type: 'signal', sessionId: record.contextId, signalName: 'confirmed' },
        },
      ],
      ...(baseRevision === undefined ? {} : { baseRevision }),
    },
    { principal: record.owner },
  );
  expect(receipt.outcome).toBe('accepted');
}

/** Folds a reader's frames, up to and including the next surface snapshot, into `held`. */
async function foldNext(reader: FrameReader, held: Map<string, HeldSurface>): Promise<void> {
  for (const frame of await reader.until(EventType.ACTIVITY_SNAPSHOT)) {
    foldSurfaceEvent(held, frame.event);
  }
}

describe('reconnecting to a run and reconstructing its surface', () => {
  it('rebuilds the same surface from a live stream and from a reconnect, and only for its owner', async () => {
    await withRun(async (harness, taskId, stream) => {
      // The first client folds the live stream as the agent creates and revises the surface.
      const live = new Map<string, HeldSurface>();
      await propose(harness, taskId, 'create');
      const optedIn = new FrameReader(
        await harness.handler(attachRunRequest(taskId, { ...as('alice-key'), ...OPT_IN })),
      );
      await foldNext(optedIn, live);
      expect(live.get('panel')).toMatchObject({ surfaceRevision: 1 });

      await propose(harness, taskId, 'update', 1);
      await foldNext(optedIn, live);
      const revised = live.get('panel');
      expect(revised).toMatchObject({
        surfaceId: 'panel',
        surfaceRevision: 2,
        catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
        dataModel: { note: 'later' },
      });
      expect(revised?.components.map((component) => component['id'])).toEqual([
        'title',
        'note',
        'go-label',
        'go',
        'root',
      ]);

      // The connection drops. A second attach (the reconnect) rebuilds the same surface from its
      // opening alone, with no earlier event.
      const reconnected = new Map<string, HeldSurface>();
      const second = new FrameReader(
        await harness.handler(attachRunRequest(taskId, { ...as('alice-key'), ...OPT_IN })),
      );
      await foldNext(second, reconnected);
      expect(reconnected).toEqual(live);

      // A principal that may not read the run is answered as for a missing run, and holds nothing.
      const stranger = await readAgUiStream(
        await harness.handler(attachRunRequest(taskId, { ...as('bob-key'), ...OPT_IN })),
      );
      expect(stranger).toHaveLength(1);
      expect(stranger[0]!.event).toMatchObject({ code: 'RUN_NOT_FOUND' });
      const none = new Map<string, HeldSurface>();
      for (const frame of stranger) {
        foldSurfaceEvent(none, frame.event);
      }
      expect(none.size).toBe(0);

      // Closing the surface reaches both clients as a delete, and both drop it.
      const closed = await harness.bureau.surfaces!.close(
        {
          type: 'surface.close',
          contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
          commandId: 'close',
          taskId,
          surfaceId: 'panel',
          baseRevision: 2,
          reason: 'dismissed',
        },
        { principal: (await harness.bureau.tasks.record(taskId))!.owner },
      );
      expect(closed.outcome).toBe('accepted');
      await foldNext(optedIn, live);
      await foldNext(second, reconnected);
      expect(live.size).toBe(0);
      expect(reconnected.size).toBe(0);

      harness.generate.release('hold');
      await optedIn.rest();
      await second.rest();
      await stream.rest();
    });
  });
});

/** The document's example block, as written between its code fence. */
async function documentedExample(): Promise<string> {
  const text = await readFile(
    join(import.meta.dir, '..', 'documentation', 'interactive-surface.md'),
    'utf8',
  );
  const heading = text.indexOf('\n### Reconnecting and reconstructing a surface\n');
  expect(heading).toBeGreaterThan(-1);
  const open = text.indexOf('```ts\n', heading);
  const close = text.indexOf('\n```\n', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return text.slice(open + '```ts\n'.length, close);
}

/**
 * Code reduced to what a formatter cannot change: whitespace outside string literals is removed,
 * as are the commas before a closer that a formatter adds when it wraps a line, and whitespace
 * runs in a comment become one space. A string literal is compared exactly.
 */
function normalized(code: string): string {
  const tokens =
    /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*)|([^'"`/]+|\/)/g;
  let result = '';
  for (const [, quoted, comment, other] of code.matchAll(tokens)) {
    if (quoted !== undefined) result += quoted;
    else if (comment !== undefined) result += `${comment.replace(/\s+/g, ' ')}\n`;
    else result += (other ?? '').replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');
  }
  return result;
}

describe('the reconnect example', () => {
  it('is the code block the document shows', async () => {
    const source = await readFile(import.meta.path, 'utf8');
    const first = source.indexOf("// Start of the document's example.\n");
    const last = source.indexOf("\n// End of the document's example.");
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    const body = source.slice(first + "// Start of the document's example.\n".length, last);

    expect(normalized(body)).toBe(normalized(await documentedExample()));
  });
});
