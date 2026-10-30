/**
 * COR-1913 — characterization of how a registry-level `policy` hook composes with the toolbox's
 * own `approvalPolicy`. A host that evaluates a per-tool approval setting as a registry hook
 * relies on this: the call's outcome is the most restrictive of the two verdicts
 * (`combineApprovalStatuses`), so a hook that allows can never loosen a toolbox `ask`.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createProcessLocalGrantStateStore } from './approval-binding';
import {
  type ApprovalMode,
  type ApprovalStatus,
  combineApprovalStatuses,
  evaluateApprovalStatus,
  resolveCapabilityTier,
} from './approval-policy';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import type { ToolMetadata, ToolPolicyHooks } from './is-tool';

const HOOK_STATUSES: readonly ApprovalStatus[] = ['allow', 'ask', 'deny'];
const TOOLBOX_MODES: readonly ApprovalMode[] = ['never', 'on-mutation', 'always', 'deny'];
const KINDS: readonly { readonly kind: string; readonly metadata: ToolMetadata }[] = [
  { kind: 'read-only', metadata: { readOnly: true } },
  { kind: 'mutating', metadata: { mutates: true } },
];

function hookReturning(status: ApprovalStatus): ToolPolicyHooks {
  return {
    beforeExecute() {
      if (status === 'allow') return { allow: true, status: 'allow' };
      if (status === 'deny') return { allow: false, status: 'deny', reason: 'hook denies' };
      return { allow: false, status: 'needs_approval', reason: 'hook asks' };
    },
  };
}

const OUTCOME_OF_STATUS = { allow: 'success', ask: 'action_required', deny: 'error' } as const;

describe('a registry policy hook beside the toolbox approvalPolicy', () => {
  for (const { kind, metadata } of KINDS) {
    for (const mode of TOOLBOX_MODES) {
      for (const hookStatus of HOOK_STATUSES) {
        it(`decides a ${kind} tool under toolbox mode ${mode} and a hook that says ${hookStatus} as the most restrictive of the two`, async () => {
          const tool = createTool({
            name: 'subject',
            description: 'The tool under test',
            input: z.object({}),
            metadata,
            execute: async () => ({ ok: true }),
          });
          const toolbox = createToolbox([tool], {
            approvalPolicy: { mode },
            policy: hookReturning(hookStatus),
          });
          const toolboxStatus = evaluateApprovalStatus(resolveCapabilityTier(metadata), mode);
          const expected = combineApprovalStatuses(toolboxStatus, hookStatus);

          const result = await toolbox.execute(createToolCall('subject', {}));

          expect(result.outcome).toBe(OUTCOME_OF_STATUS[expected]);
          if (expected === 'ask') expect(result.pendingApproval).toBeDefined();
        });
      }
    }
  }
});

/** COR-1947 — the hook that decides a call before a reusable grant can answer it. */
describe('a beforeAdmission hook beside a reusable grant', () => {
  const requestContext = {
    authority: {
      principalId: 'alice',
      tenantId: 'tenant',
      ownerId: 'owner',
      capabilities: [],
      authorizationRevision: '1',
    },
    audience: 'operator',
    agentId: 'agent',
    runId: 'run',
  } as const;

  /** A toolbox holding a grant for `subject`, with `policy` on the tool. */
  async function granted(policy: ToolPolicyHooks) {
    const grants = createProcessLocalGrantStateStore();
    const ran: string[] = [];
    const toolbox = createToolbox(
      [
        createTool({
          name: 'subject',
          version: '1.0.0',
          description: 'The tool under test',
          input: z.object({}),
          metadata: { mutates: true },
          policy,
          execute: async () => {
            ran.push('subject');
            return { ok: true };
          },
        }),
      ],
      { approvalSecret: 'secret', approvalPolicy: { mode: 'always' }, grantStateStore: grants },
    );
    const { id } = await toolbox.issueGrant({
      principalId: 'alice',
      tenantId: 'tenant',
      ownerId: 'owner',
      agentId: 'agent',
      toolName: 'subject',
      scope: 'principal',
      expiresAt: Number.MAX_SAFE_INTEGER,
      maxUses: 5,
      delegationBehavior: 'does-not-propagate',
    });
    const call = () => toolbox.execute(createToolCall('subject', {}), { requestContext });
    const usesLeft = async () => {
      const grant = await grants.get(id);
      return grant?.usesRemaining;
    };
    return { call, ran, usesLeft };
  }

  it('leaves the grant to answer a call the hook has nothing to say about', async () => {
    const { call, ran, usesLeft } = await granted({ beforeAdmission: () => undefined });

    const { outcome } = await call();

    expect(outcome).toBe('success');

    expect(ran).toEqual(['subject']);
    expect(await usesLeft()).toBe(4);
  });

  it('denies a call a grant would have answered, and spends nothing', async () => {
    const { call, ran, usesLeft } = await granted({
      beforeAdmission: () => ({ allow: false, status: 'deny', reason: 'not now' }),
    });

    const { outcome } = await call();

    expect(outcome).toBe('error');

    expect(ran).toEqual([]);
    expect(await usesLeft()).toBe(5);
  });

  it('pauses a call a grant would have answered, and spends nothing', async () => {
    const { call, ran, usesLeft } = await granted({
      beforeAdmission: () => ({ allow: false, status: 'needs_approval', reason: 'ask first' }),
    });

    const { outcome } = await call();

    expect(outcome).toBe('action_required');

    expect(ran).toEqual([]);
    expect(await usesLeft()).toBe(5);
  });
});
