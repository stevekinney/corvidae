/**
 * Fork-comparison demo fixture (COR-2538). See `fixtures/workflows.ts` for the append-only contract
 * this file participates in.
 *
 * - `fork-comparison`: a finished run with two durable steps. `reserveStock` is deterministic, so a
 *   fork keeps it. `issueTicket` hands out the next ticket number of this process, so running it
 *   again (which a fork from the last checkpoint does) answers a different ticket than the source
 *   run's: the comparison has a payload to show that differs.
 */
import { activity, workflow, type WorkflowHandle } from '@lostgradient/weft';

import { FORK_COMPARISON_RUN_ID } from './fork-comparison-ids.ts';

const reserveStock = activity({
  name: 'reserveStock',
  execute: async (input: { order: string }) => ({ reserved: input.order, warehouse: 'north' }),
});

/** The tickets this process has issued: each run of `issueTicket` takes the next number. */
let ticketsIssued = 0;

const issueTicket = activity({
  name: 'issueTicket',
  execute: async (input: { order: string }) => {
    ticketsIssued += 1;
    return { order: input.order, ticket: ticketsIssued };
  },
});

export const forkComparison = workflow({ name: 'fork-comparison' })
  .activities({ reserveStock, issueTicket })
  .execute(async function* (ctx, input: { order: string }) {
    yield* ctx.run(reserveStock, { order: input.order });
    return yield* ctx.run(issueTicket, { order: input.order });
  });

/** Registerable workflow map — merged into `fixtures/workflows.ts`'s registry. */
export const forkComparisonWorkflows = {
  'fork-comparison': forkComparison,
};

/** Narrow structural interface — see `fixtures/workflows.ts` for the pattern. */
export interface ForkComparisonEngine {
  start(
    name: 'fork-comparison',
    input: { order: string },
    options: { id: string },
  ): Promise<WorkflowHandle>;
}

/** Starts the run under its fixed identifier and waits for it to finish. */
export async function seedForkComparison(engine: ForkComparisonEngine): Promise<void> {
  const handle = await engine.start(
    'fork-comparison',
    { order: 'ord_6001' },
    { id: FORK_COMPARISON_RUN_ID },
  );
  await handle.result();
}
