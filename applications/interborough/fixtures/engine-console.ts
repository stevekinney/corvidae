/**
 * Run-detail demo fixtures for the Engine console's attributes, streams and updates sections
 * (COR-1461, COR-1462, COR-1463). Each workflow stays `running`, parked on a signal, because what it
 * shows does not survive the run ending: a terminal run purges its caller-supplied search
 * attributes, and a cancelled or timed-out one sweeps its stream chunks. See `fixtures/workflows.ts`
 * for the append-only contract this file participates in.
 *
 * - `attribute-showcase`: one search attribute of every type the console edits (string, number,
 *   boolean, date, list of strings).
 * - `chunk-streamer`: a durable stream (`progress`) with three stored chunks.
 * - `update-desk`: handles three updates. `greet` answers, `explode` fails, `slow` answers after longer
 *   than a one-second wait, so a form submission with a short timeout times out and the answer
 *   arrives later. Two updates (`greet`, `explode`) are sent here, so the page opens with a history.
 */
import {
  workflow,
  type CoordinatedUpdateResult,
  type SearchAttributeValue,
  type WorkflowContext,
  type WorkflowHandle,
} from '@lostgradient/weft';

import {
  ATTRIBUTE_SHOWCASE_RUN_ID,
  CHUNK_STREAMER_RUN_ID,
  UPDATE_DESK_REPLAY_RUN_ID,
  UPDATE_DESK_RUN_ID,
} from './engine-console-ids.ts';

const ATTRIBUTE_PERSISTENCE_POLL_ATTEMPTS = 25;
const ATTRIBUTE_PERSISTENCE_POLL_DELAY_MS = 20;
/** How long the `slow` update's handler takes: longer than the one-second timeout a spec gives it. */
const SLOW_UPDATE_DELAY_MS = 2_500;
const SEED_UPDATE_TIMEOUT_MS = 10_000;

export const attributeShowcase = workflow({ name: 'attribute-showcase' })
  .searchAttributes({
    owner: { type: 'string' },
    priority: { type: 'number' },
    urgent: { type: 'boolean' },
    reviewBy: { type: 'string', format: 'date-time' },
    labels: { type: 'array', items: { type: 'string' } },
  })
  .execute(async function* (ctx: WorkflowContext, input: { name: string }) {
    yield* ctx.waitForSignal('finish');
    return { name: input.name };
  });

export const chunkStreamer = workflow({ name: 'chunk-streamer' }).execute(async function* (
  ctx: WorkflowContext,
  input: { name: string },
) {
  yield* ctx.stream('progress', async function* () {
    yield { stage: 'queued' };
    yield { stage: 'running' };
    yield { stage: 'verifying' };
  });
  yield* ctx.waitForSignal('finish');
  return { name: input.name };
});

export const updateDesk = workflow({ name: 'update-desk' }).execute(async function* (
  ctx: WorkflowContext,
  _input: { name: string },
) {
  ctx.onUpdate('greet', (payload) => `hello ${String(payload)}`);
  ctx.onUpdate('explode', () => {
    throw new Error('the desk refused this update');
  });
  ctx.onUpdate('slow', async (payload) => {
    await Bun.sleep(SLOW_UPDATE_DELAY_MS);
    return `slow-done:${String(payload)}`;
  });
  yield* ctx.waitForSignal('close');
  return 'closed';
});

/** Registerable workflow map — merged into `fixtures/workflows.ts`'s registry. */
export const engineConsoleWorkflows = {
  'attribute-showcase': attributeShowcase,
  'chunk-streamer': chunkStreamer,
  'update-desk': updateDesk,
};

/** The attributes `attribute-showcase` starts with: the values the specs read and then change. */
export const ATTRIBUTE_SHOWCASE_ATTRIBUTES = {
  owner: 'ops-team',
  priority: 2,
  urgent: false,
  reviewBy: new Date('2026-12-01T09:00:00.000Z'),
  labels: ['quarterly', 'finance'],
} as const satisfies Record<string, SearchAttributeValue>;

/** Narrow structural interface — see `fixtures/workflows.ts` for the pattern. */
export interface EngineConsoleEngine {
  start(
    name: 'attribute-showcase',
    input: { name: string },
    options?: {
      id?: string;
      searchAttributes?: Record<string, SearchAttributeValue>;
      defer?: boolean;
    },
  ): Promise<WorkflowHandle>;
  start(
    name: 'chunk-streamer',
    input: { name: string },
    options?: { id?: string },
  ): Promise<WorkflowHandle>;
  start(
    name: 'update-desk',
    input: { name: string },
    options?: { id?: string; defer?: boolean },
  ): Promise<WorkflowHandle>;
  getAttributes(workflowId: string): Promise<Record<string, SearchAttributeValue> | null>;
  submitCoordinatedUpdate(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<CoordinatedUpdateResult>;
}

/**
 * `start()` resolves once the generator has been driven to its first yield, not once the checkpoint
 * that writes the queryable attribute record has landed (see `fixtures/tagged.ts`); poll for it so
 * the dev server never serves a run whose attributes are not there yet.
 */
async function waitForCommittedAttributes(
  engine: EngineConsoleEngine,
  workflowId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= ATTRIBUTE_PERSISTENCE_POLL_ATTEMPTS; attempt++) {
    if ((await engine.getAttributes(workflowId)) !== null) return;
    await Bun.sleep(ATTRIBUTE_PERSISTENCE_POLL_DELAY_MS);
  }
  throw new Error(
    `seedEngineConsole: search attributes for workflow ${workflowId} were not committed in time`,
  );
}

/**
 * Starts one run of each workflow above and sends `update-desk` its two seeded updates, so a spec
 * finds a run with attributes, a run with stored stream chunks, and a run with a history of one
 * completed and one failed update.
 */
export async function seedEngineConsole(engine: EngineConsoleEngine): Promise<void> {
  const showcase = await engine.start(
    'attribute-showcase',
    { name: 'quarterly-review' },
    {
      id: ATTRIBUTE_SHOWCASE_RUN_ID,
      searchAttributes: {
        ...ATTRIBUTE_SHOWCASE_ATTRIBUTES,
        labels: [...ATTRIBUTE_SHOWCASE_ATTRIBUTES.labels],
      },
      defer: false,
    },
  );
  await waitForCommittedAttributes(engine, showcase.id);

  await engine.start('chunk-streamer', { name: 'nightly-export' }, { id: CHUNK_STREAMER_RUN_ID });

  const desk = await engine.start(
    'update-desk',
    { name: 'front-desk' },
    { id: UPDATE_DESK_RUN_ID, defer: false },
  );
  const greeted = await engine.submitCoordinatedUpdate(desk.id, 'greet', 'ada', {
    timeout: SEED_UPDATE_TIMEOUT_MS,
  });
  if (greeted.error !== undefined) throw new Error(`seeded greet update failed: ${greeted.error}`);
  // The failing update answers with the handler's message rather than throwing.
  const exploded = await engine.submitCoordinatedUpdate(desk.id, 'explode', null, {
    timeout: SEED_UPDATE_TIMEOUT_MS,
  });
  if (exploded.error === undefined) throw new Error('the seeded explode update did not fail');

  // A desk nobody has sent anything to: its history must hold exactly what one browser send makes.
  await engine.start(
    'update-desk',
    { name: 'replay-desk' },
    { id: UPDATE_DESK_REPLAY_RUN_ID, defer: false },
  );
}
