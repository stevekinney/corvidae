import { defineOperation, type Principal } from '@lostgradient/backchannel';
import type { Bureau, BureauReviews, BureauTasks } from '@lostgradient/bureau';
import { reviewedToolOperations } from '@lostgradient/bureau/tool-operations';
import { definePlugin } from '@lostgradient/interborough-plugin';
import { WorkflowClaimUnavailableError } from '@lostgradient/weft';
import type { AnyToolbox, ApprovalStateStore, ToolRequestContext } from 'armorer';
import { z } from 'zod';
import { REFUND_TOOL_REVISION, type createRefundLedger, type Refund } from './refund-ledger.ts';

/** The host supplies current merchant authority on every request, including retries. */
export interface RefundAccess {
  request(
    principal: Principal,
    orderId: string,
  ): Promise<{ merchant: string; owner: string } | undefined>;
  read(principal: Principal, refund: Refund): Promise<boolean>;
  isRequester(principal: Principal, refund: Refund): Promise<boolean>;
  decide(principal: Principal, refund: Refund): Promise<boolean>;
}
type RefundWorkerHost = {
  tasks: BureauTasks;
  reviews: BureauReviews;
  internals: Pick<Bureau['internals'], 'whenTaskRecorded' | 'sessionStore'>;
  requestContext(refund: Refund): Promise<ToolRequestContext>;
};

const refundView = (refund: Refund) => ({
  refundId: refund.id,
  orderId: refund.order,
  cents: refund.amount,
  currency: refund.currency,
  status: refund.status === 'admitted' && refund.reviewId ? 'awaiting-approval' : refund.status,
  ...(refund.reviewId ? { reviewId: refund.reviewId } : {}),
});

/** Bind the selected demo tool to Bureau's signed-call and review policy. */
export function reviewedRefundContribution(options: {
  ledger: ReturnType<typeof createRefundLedger>;
  access: RefundAccess;
  toolbox: AnyToolbox;
  toolId: string;
  approvalStateStore: ApprovalStateStore;
  requestContext(principal: Principal): ToolRequestContext;
}) {
  const { ledger, access } = options;
  if (options.toolbox.getTool(options.toolId)?.name !== 'issue-refund')
    throw new Error('Refund contribution requires the pinned issue-refund tool');
  const refundForRun = async (runId: string) => {
    const start = await ledger.startForRun(runId);
    return start ? ledger.get(start.refundId) : undefined;
  };
  const contribution = reviewedToolOperations(
    options.toolbox,
    [
      {
        tool: options.toolId,
        agent: 'demo-refund',
        request: 'demo.refunds.request',
        get: 'demo.refunds.get',
        intentId: 'refundId',
        outputSchema: z.strictObject({
          refundId: z.string(),
          orderId: z.string(),
          cents: z.number(),
          currency: z.string(),
          status: z.string(),
          reviewId: z.string().optional(),
        }),
        effectSchema: z.strictObject({
          kind: z.literal('refund'),
          refundId: z.string(),
          orderId: z.string(),
          cents: z.number().int().positive(),
          currency: z.literal('USD'),
          status: z.enum([
            'admitted',
            'submitting',
            'provider-pending',
            'succeeded',
            'failed',
            'needs-reconciliation',
          ]),
        }),
        intents: {
          async prepare({ runId, commandId, arguments: args }) {
            const refund = await refundForRun(runId);
            if (
              !refund ||
              refund.id !== commandId ||
              refund.order !== args['orderId'] ||
              refund.amount !== args['cents'] ||
              refund.currency !== args['currency']
            )
              throw new Error('Refund does not match the reserved run');
            return {
              refundId: refund.id,
              orderId: refund.order,
              cents: refund.amount,
              currency: refund.currency,
            };
          },
          async readRun({ runId, principal }) {
            const refund = await refundForRun(runId);
            if (!refund || !(await access.read(principal, refund)))
              throw new Error('Refund not found');
            return refundView(refund);
          },
          async read({ identifier, principal }) {
            const refund = await ledger.get(identifier);
            if (!refund || !(await access.read(principal, refund)))
              throw new Error('Refund not found');
            return refundView(refund);
          },
          async effect(review) {
            const refund = await refundForRun(review.runId);
            if (!refund) throw new Error('Refund not found');
            return {
              kind: 'refund' as const,
              refundId: refund.id,
              orderId: refund.order,
              cents: refund.amount,
              currency: refund.currency,
              status: refund.status,
            };
          },
        },
        access: {
          requestScopes: ['demo.refunds:request'],
          readScopes: ['demo.refunds:read'],
          async mayRead(review, principal) {
            const refund = await refundForRun(review.runId);
            return !!refund && access.read(principal, refund);
          },
          async mayDecide(review, principal) {
            const refund = await refundForRun(review.runId);
            return (
              !!refund &&
              !(await access.isRequester(principal, refund)) &&
              access.decide(principal, refund)
            );
          },
        },
        mcpExposable: true,
      },
    ],
    {
      approvalStateStore: options.approvalStateStore,
      requestContext: (principal) => options.requestContext(principal),
    },
  );
  const drain = async (refundId: string, host: RefundWorkerHost) => {
    const initial = await ledger.getStart(refundId);
    if (!initial) throw new Error('Refund start not found');
    const workflow =
      initial.status === 'pending' ? await host.tasks.workflow(initial.runId) : undefined;
    const claim =
      initial.status === 'pending' && (workflow === null || workflow?.status === 'pending')
        ? await host.tasks.reserveStartClaim(initial.runId)
        : undefined;
    let handedOff = false;
    try {
      const start = await ledger.claimStart(refundId);
      const refund = await ledger.get(refundId);
      if (!refund) throw new Error('Refund not found');
      if (start.status === 'pending') {
        const task = await contribution.startReserved(
          'demo.refunds.request',
          host.tasks,
          {
            commandId: refund.id,
            orderId: refund.order,
            cents: refund.amount,
            currency: refund.currency,
          },
          {
            principal: refund.owner,
            requestContext: await host.requestContext(refund),
            reservation: { runId: start.runId, sessionId: start.sessionId, fence: start.fence },
          },
        );
        if (task.id !== start.runId || task.contextId !== start.sessionId)
          throw new Error('Bureau returned a different reserved task');
        if (task.receipt?.status === 'pending') return false;
        if (!(await host.tasks.wait(start.runId))) return false;
      } else if (!(await host.tasks.wait(start.runId))) return false;
      await host.internals.whenTaskRecorded(start.runId);
      const reviewId = `approval:${start.runId}:reviewed-call`;
      const review = await host.reviews.get(reviewId);
      if (!review || review.kind !== 'tool-approval' || review.runId !== start.runId) return false;
      if (review.status === 'pending') {
        const session = await host.internals.sessionStore?.load(start.sessionId);
        const overrides = session?.metadata['pendingApprovalOverrides'];
        if (
          session?.metadata['lastRunId'] !== start.runId ||
          session.metadata['lastRunStatus'] !== 'completed' ||
          !overrides ||
          typeof overrides !== 'object' ||
          Array.isArray(overrides) ||
          !Object.hasOwn(overrides, reviewId) ||
          JSON.stringify(Reflect.get(overrides, reviewId)) !== JSON.stringify(review.approval)
        )
          return false;
      }
      if (start.status === 'pending' && !(await ledger.completeStart(refundId, start.fence)))
        return false;
      if (!(await ledger.linkReview(refundId, start.runId, reviewId))) return false;
      claim?.handoff();
      handedOff = true;
      if (['denied', 'rejected', 'expired', 'revoked', 'canceled'].includes(review.status))
        await ledger.cancel(refundId);
      return true;
    } finally {
      if (!handedOff) await claim?.release();
    }
  };
  let wake: ((refundId: string) => void) | undefined;
  return {
    ...contribution,
    reviewEffects: [],
    releasePlugin: definePlugin({
      name: 'reviewed',
      title: 'Reviewed refund release',
      version: '1.0.0',
      description: 'Releases denied reviewed refund reservations.',
      enabled: true,
      async setup() {
        return {
          releases: [
            {
              name: 'refund',
              agent: 'demo-refund',
              tool: 'issue-refund',
              toolRevision: options.toolId,
              identifier(arguments_) {
                return z.object({ refundId: z.string().uuid() }).passthrough().parse(arguments_)
                  .refundId;
              },
              async release(input) {
                const refund = await ledger.get(input.identifier);
                if (
                  !refund ||
                  refund.existingRunId !== input.runId ||
                  input.toolRevision !== options.toolId
                )
                  throw new Error('Terminal review does not match the refund');
                await ledger.cancel(refund.id);
              },
            },
          ],
        };
      },
    }),
    operations: refundOperations(
      ledger,
      access,
      (refundId) => wake?.(refundId),
      () => {
        if (!wake) throw new Error('Refund admission worker is unavailable');
      },
    ),
    drain,
    async attachWorker(
      host: RefundWorkerHost & { events: Pick<Bureau, 'addEventListener' | 'removeEventListener'> },
      onError: (error: unknown, refundId: string) => void,
    ) {
      if (!host.tasks.reservedStartsSupported)
        throw new Error('Refund admission requires durable workflow-lease ownership');
      if (wake) throw new Error('Refund worker already attached');
      const pending = new Map<string, Promise<void>>();
      const retries = new Map<string, ReturnType<typeof setTimeout>>();
      const failures: unknown[] = [];
      let disposed = false;
      const schedule = (refundId: string) => {
        if (disposed || pending.has(refundId)) return;
        const retry = retries.get(refundId);
        if (retry !== undefined) {
          clearTimeout(retry);
          retries.delete(refundId);
        }
        const settled = Promise.withResolvers<void>();
        pending.set(refundId, settled.promise);
        setTimeout(() => {
          void drain(refundId, host)
            .then((completed) => {
              if (!completed) throw new Error('Refund admission or review could not be confirmed');
              return undefined;
            })
            .catch((error: unknown) => {
              if (error instanceof WorkflowClaimUnavailableError) {
                if (disposed) return undefined;
                const timer = setTimeout(() => {
                  retries.delete(refundId);
                  schedule(refundId);
                }, 5_000);
                timer.unref();
                retries.set(refundId, timer);
                return undefined;
              }
              failures.push(error);
              try {
                onError(error, refundId);
              } catch (reportError) {
                failures.push(reportError);
              }
              return undefined;
            })
            .finally(() => {
              pending.delete(refundId);
              settled.resolve();
            });
        }, 0);
      };
      wake = schedule;
      const closed = (event: { runId: string }) => {
        const eventKey = `review:${event.runId}`;
        if (pending.has(eventKey)) return;
        const reading = ledger
          .startForRun(event.runId)
          .then(
            (start) => {
              if (start) schedule(start.refundId);
              return undefined;
            },
            (error: unknown) => {
              failures.push(error);
              try {
                onError(error, event.runId);
              } catch (reportError) {
                failures.push(reportError);
              }
              return undefined;
            },
          )
          .finally(() => {
            pending.delete(eventKey);
          });
        pending.set(eventKey, reading);
      };
      const events = [
        'review.denied',
        'review.rejected',
        'review.expired',
        'review.revoked',
        'review.canceled',
      ] as const;
      for (const event of events) host.events.addEventListener(event, closed);
      const recover = async () => {
        for (const refund of await ledger.awaitingReview())
          if (await ledger.getStart(refund.id)) schedule(refund.id);
      };
      try {
        await recover();
      } catch (error) {
        disposed = true;
        for (const timer of retries.values()) clearTimeout(timer);
        retries.clear();
        wake = undefined;
        for (const event of events) host.events.removeEventListener(event, closed);
        while (pending.size > 0) await Promise.all(pending.values());
        throw error;
      }
      return {
        recover,
        async idle() {
          while (pending.size > 0) await Promise.all(pending.values());
          if (failures.length > 0)
            throw new AggregateError(failures.splice(0), 'Refund worker failed');
        },
        async dispose() {
          disposed = true;
          for (const timer of retries.values()) clearTimeout(timer);
          retries.clear();
          if (wake === schedule) wake = undefined;
          for (const event of events) host.events.removeEventListener(event, closed);
          while (pending.size > 0) await Promise.all(pending.values());
          if (failures.length > 0)
            throw new AggregateError(failures.splice(0), 'Refund worker failed');
        },
      };
    },
  };
}

export function refundOperations(
  ledger: ReturnType<typeof createRefundLedger>,
  access: RefundAccess,
  onAdmitted?: (refundId: string) => void,
  assertReady?: () => void,
) {
  const notFound = () => ({ code: 'NotFound' as const, message: 'Refund not found', data: {} });
  const request = defineOperation({
    name: 'demo.refunds.request',
    summary: 'Request a refund for an order.',
    behavior: { kind: 'command' },
    destructive: true,
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    inputSchema: z.strictObject({
      commandId: z.string().min(1).max(200),
      orderId: z.string().min(1),
      cents: z.number().int().positive().safe(),
    }),
    outputSchema: z.strictObject({ accepted: z.literal(true), refundId: z.string() }),
    access: { kind: 'authenticated' },
    mcpExposable: true,
    transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: false },
    invoke: async ({ input, principal }) => {
      assertReady?.();
      const authority = await access.request(principal, input.orderId);
      if (!authority) throw notFound();
      const existing = await ledger.find(authority.merchant, input.commandId);
      if (existing && !(await access.read(principal, existing))) throw notFound();
      if (!existing) {
        const charge = await ledger.balance(authority.merchant, input.orderId);
        if (!charge || charge.currency !== 'USD') throw notFound();
      }
      let refund: Refund;
      try {
        refund = await ledger.admit({
          merchant: authority.merchant,
          owner: existing?.owner ?? authority.owner,
          commandId: input.commandId,
          order: input.orderId,
          amount: input.cents,
          toolRevision: REFUND_TOOL_REVISION,
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'Conflict') {
          const bound = await ledger.find(authority.merchant, input.commandId);
          if (!bound || !(await access.read(principal, bound))) throw notFound();
          throw { code: 'Conflict', message: 'Command already used for another refund', data: {} };
        }
        throw error;
      }
      if (!(await access.read(principal, refund))) throw notFound();
      if (!refund.reviewId) onAdmitted?.(refund.id);
      return { accepted: true as const, refundId: refund.id };
    },
  });
  const get = defineOperation({
    name: 'demo.refunds.get',
    summary: 'Read a refund.',
    behavior: { kind: 'read' },
    destructive: false,
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    inputSchema: z.strictObject({ refundId: z.string().min(1) }),
    outputSchema: z.strictObject({
      refundId: z.string(),
      orderId: z.string(),
      cents: z.number(),
      currency: z.string(),
      status: z.string(),
      reviewId: z.string().optional(),
    }),
    access: { kind: 'authenticated' },
    mcpExposable: true,
    transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: false },
    invoke: async ({ input, principal }) => {
      const refund = await ledger.get(input.refundId);
      if (!refund || !(await access.read(principal, refund))) throw notFound();
      return refundView(refund);
    },
  });
  return [request, get] as const;
}
