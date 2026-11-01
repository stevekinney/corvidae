/**
 * Run-steps demo fixtures for the run page's steps list, step logs and Related runs (COR-1860). See
 * `fixtures/workflows.ts` for the append-only contract this file participates in.
 *
 * - `logged-steps`: a finished run with three steps and `ctx.log` lines before each of them and one
 *   after the last, one line carrying a 300-character unbroken value, one step with a long
 *   unbroken name. It starts two `logged-step-child` runs, so its page lists children, and each
 *   child's page lists the other as a sibling.
 */
import { activity, workflow, type WorkflowHandle } from '@lostgradient/weft';

import { RUN_STEPS_RUN_ID } from './run-steps-ids.ts';

/** A value no line can break at, logged to see that the step and the whole log wrap it. */
export const RUN_STEPS_LONG_VALUE = `logged-${'v'.repeat(300)}`;

const LONG_STEP_NAME = `settleLedger${'X'.repeat(120)}` as const;

const prepareShipment = activity({
  name: 'prepareShipment',
  execute: async (input: { order: string }) => ({ prepared: input.order }),
});

const settle = activity({
  name: LONG_STEP_NAME,
  execute: async (input: { order: string }) => ({ settled: input.order }),
});

export const loggedStepChild = workflow({ name: 'logged-step-child' })
  .activities({ prepareShipment })
  .execute(async function* (ctx, input: { order: string }) {
    ctx.log?.info('child started', { order: input.order });
    // One durable step, so the child's own page has a step to list.
    yield* ctx.run(prepareShipment, { order: input.order });
    return { order: input.order };
  });

export const loggedSteps = workflow({ name: 'logged-steps' })
  .activities({ prepareShipment, [LONG_STEP_NAME]: settle })
  .execute(async function* (ctx, input: { order: string }) {
    ctx.log?.info('run started', { order: input.order });
    yield* ctx.run(prepareShipment, { order: input.order });
    ctx.log?.warn('prepared, about to settle', { value: RUN_STEPS_LONG_VALUE });
    yield* ctx.startChild('logged-step-child', { order: `${input.order}-a` });
    yield* ctx.startChild('logged-step-child', { order: `${input.order}-b` });
    ctx.log?.debug('children done');
    yield* ctx.run(settle, { order: input.order });
    ctx.log?.error('finished after the last step');
    return { order: input.order };
  });

/** Registerable workflow map — merged into `fixtures/workflows.ts`'s registry. */
export const runStepsWorkflows = {
  'logged-steps': loggedSteps,
  'logged-step-child': loggedStepChild,
};

/** Narrow structural interface — see `fixtures/workflows.ts` for the pattern. */
export interface RunStepsEngine {
  start(
    name: 'logged-steps',
    input: { order: string },
    options: { id: string },
  ): Promise<WorkflowHandle>;
}

/** Starts the logged run under its fixed identifier and waits for it to finish. */
export async function seedRunSteps(engine: RunStepsEngine): Promise<void> {
  const handle = await engine.start(
    'logged-steps',
    { order: 'ord_5001' },
    { id: RUN_STEPS_RUN_ID },
  );
  await handle.result();
}
