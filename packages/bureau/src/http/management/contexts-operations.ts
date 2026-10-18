/**
 * `bureau.contexts.*`: a context is a Bureau session, the same identifier as the
 * A2A `contextId` (`documentation/external-control-plane.md`, "Tasks and contexts").
 *
 * A context belongs to the principal that created it. A caller reaches its own
 * contexts without any scope; `bureau.contexts:write` grants `delete` on any
 * owner's, and a context the caller may not see is answered exactly as a missing
 * one. A context that is the id of a `bureau.run` dispatch with no session behind
 * it is missing here: a catalog run owns no session.
 *
 * @module contexts-operations
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import { aggregateCleanup, type TaskRegistry } from '../../task-registry.ts';
import type { Bureau } from '../../types.ts';
import { type BureauOwnershipHost } from '../owner-predicate.ts';
import {
  resourceNotFound,
  taskCleanupSchema,
  unaryTransports as transports,
  unknownKeyPolicy,
  waitMillisecondsField,
} from './management-schemas.ts';
import { holdsScope } from './tasks-operations.ts';

/** What the context operations read from the handler's `host`. */
export type BureauContextsOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<Bureau, 'getSession' | 'deleteSession' | 'getOwner' | 'lifecycle'> & {
    readonly sessionStore: Bureau['sessionStore'];
  };
  readonly tasks: Pick<TaskRegistry, 'settleCleanup'>;
};

/** Whether `principal` may act on the context `contextId` with `operatorScope`. */
async function mayAccessContext(
  host: BureauContextsOperationHost,
  principal: Principal,
  contextId: string,
  operatorScope: 'bureau.contexts:write',
): Promise<boolean> {
  const resourceOwner = holdsScope(principal, operatorScope)
    ? undefined
    : await host.contexts.getOwner({ kind: 'session', id: contextId });
  return host.ownership.mayAccess({ principal, resourceOwner, operatorScope });
}

const contextsDeleteInput = z.object({
  contextId: z.string().min(1),
  waitMilliseconds: waitMillisecondsField,
});

/** The receipt `bureau.contexts.delete` answers with. */
export const contextDeleteReceiptSchema = z.enum([
  'applied',
  'rejected',
  'cleanup-pending',
  'cleaned-up',
  'cleanup-failed',
  'cleanup-unresolved',
  'unknown-outcome',
]);

const contextsDeleteOutput = z.object({
  contextId: z.string(),
  receipt: contextDeleteReceiptSchema,
  reason: z.literal('shutting-down').optional(),
  /** Every live task the deletion cancelled, each with where its own cleanup stands. */
  tasks: z.array(z.object({ taskId: z.string(), cleanup: taskCleanupSchema })),
});

export const contextsDeleteOperation = defineOperation<
  typeof contextsDeleteInput,
  typeof contextsDeleteOutput,
  BureauContextsOperationHost
>({
  name: 'bureau.contexts.delete',
  mcpExposable: false,
  summary: 'Delete a context',
  description:
    'Deletes one of the caller’s own contexts; a caller holding `bureau.contexts:write` deletes any owner’s. The deletion fences the context first, so a new task or session input for it reads as a context that does not exist, then cancels and awaits every live task in it, then removes the context and empties its tasks’ message histories. The `receipt` is `applied` (no task was live), or the aggregate of the cancelled tasks’ cleanup, the least settled winning: `cleanup-pending`, `cleanup-unresolved`, `unknown-outcome`, `cleanup-failed`, `cleaned-up`; `tasks` lists each. `rejected` (reason `shutting-down`) means admission is closed and nothing was applied. `waitMilliseconds` (default 0) waits that long for outstanding cleanup acknowledgements.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsDeleteInput,
  outputSchema: contextsDeleteOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.sessionStore === undefined) {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no sessions, so it has no contexts to delete',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    // Missing, a catalog run's id, and not the caller's all answer alike.
    if (
      !(await mayAccessContext(host, principal, contextId, 'bureau.contexts:write')) ||
      (await host.contexts.getSession(contextId)) === undefined
    ) {
      throw resourceNotFound('context', contextId);
    }
    if (host.contexts.lifecycle !== 'ready') {
      return {
        contextId,
        receipt: 'rejected' as const,
        reason: 'shutting-down' as const,
        tasks: [],
      };
    }
    const report = await host.contexts.deleteSession(contextId);
    if (report.tasks.length === 0) return { contextId, receipt: 'applied' as const, tasks: [] };
    const cleanups = await host.tasks.settleCleanup(report.tasks, input.waitMilliseconds ?? 0);
    const receipt = aggregateCleanup(cleanups.map((task) => task.cleanup)) ?? 'applied';
    return { contextId, receipt, tasks: cleanups.map((task) => ({ ...task })) };
  },
});
