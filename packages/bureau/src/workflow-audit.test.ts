/**
 * COR-1529 — every write to a workflow file is an audit entry under `workflow:<identifier>`,
 * whether an agent's tool or an HTTP caller made it: its actor is `agent-run:<runId>` for the tool
 * and the calling principal for HTTP, an entry that changed nothing is not written, and the entry
 * belongs to the deployment's owner, so it is visible to the owner and hidden from anyone else.
 */
import { principalFromApiKey, unauthenticatedLocalAuthContext } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { AUDIT_WORKFLOW_OWNER_PREFIX, auditTrailWorkflowOwnerId } from './audit-trail';
import { mayAccessOwnedResource } from './http/owner-predicate';
import { rpc } from './http/management/management-fixtures.test-support';
import { ownerRpc, serveWorkflows } from './http/management/workflows-fixtures.test-support';
import {
  startWorkflowToolsBureau,
  type WorkflowToolsHarness,
} from './testing/workflow-tools-bureau.test-support';
import type { BureauInternals } from './types';

const harnesses: WorkflowToolsHarness[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const TRIGGER = { kind: 'schedule', spec: '1h' };
const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Write the digest' } },
];

async function trail(
  bureau: { readonly internals: Pick<BureauInternals, 'auditTrail'> },
  id: string,
) {
  const entries =
    (await bureau.internals.auditTrail?.query({ runId: auditTrailWorkflowOwnerId(id) })) ?? [];
  return entries.map((entry) => ({
    type: entry.type,
    principal: entry.principal,
    runId: entry.runId,
    detail: entry.detail as { id: string; hash: string; previousHash?: string },
  }));
}

describe('the workflow subject', () => {
  it('is workflow:<identifier>', () => {
    expect(AUDIT_WORKFLOW_OWNER_PREFIX).toBe('workflow:');
    expect(auditTrailWorkflowOwnerId('digest')).toBe('workflow:digest');
  });
});

describe('a write an agent’s tool made', () => {
  it('is an entry whose actor is the agent run, for created, updated, paused, and resumed', async () => {
    const harness = await startWorkflowToolsBureau();
    harnesses.push(harness);
    const hashOf = () => harness.bureau.workflows!.list()[0]!.hash!;

    const created = await harness.callTool('workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    const first = hashOf();
    const updated = await harness.callTool('workflows-update', {
      id: 'digest',
      expectedHash: first,
      trigger: { kind: 'schedule', spec: '2h' },
      steps: STEPS,
    });
    const second = hashOf();
    const paused = await harness.callTool('workflows-pause', {
      id: 'digest',
      expectedHash: second,
    });
    const third = hashOf();
    const resumed = await harness.callTool('workflows-resume', {
      id: 'digest',
      expectedHash: third,
    });
    const fourth = hashOf();

    const entries = await trail(harness.bureau, 'digest');
    expect(entries.map((entry) => entry.type)).toEqual([
      'workflow.created',
      'workflow.updated',
      'workflow.paused',
      'workflow.resumed',
    ]);
    expect(entries.map((entry) => entry.principal)).toEqual([
      `agent-run:${created.runId}`,
      `agent-run:${updated.runId}`,
      `agent-run:${paused.runId}`,
      `agent-run:${resumed.runId}`,
    ]);
    expect(entries.every((entry) => entry.runId === 'workflow:digest')).toBe(true);
    expect(entries.map((entry) => entry.detail)).toEqual([
      { id: 'digest', hash: first },
      { id: 'digest', hash: second, previousHash: first },
      { id: 'digest', hash: third, previousHash: second },
      { id: 'digest', hash: fourth, previousHash: third },
    ]);
  });

  it('writes no entry for a write that changed nothing, was refused, or was not the owner’s', async () => {
    const harness = await startWorkflowToolsBureau();
    harnesses.push(harness);
    await harness.callTool('workflows-create', { name: 'Digest', trigger: TRIGGER, steps: STEPS });
    const hash = harness.bureau.workflows!.list()[0]!.hash!;
    await harness.callTool('workflows-pause', { id: 'digest', expectedHash: hash });
    const paused = harness.bureau.workflows!.list()[0]!.hash!;
    const before = await trail(harness.bureau, 'digest');
    expect(before.map((entry) => entry.type)).toEqual(['workflow.created', 'workflow.paused']);

    // Pausing a paused workflow, a stale hash, a name that cannot be an identifier, a document
    // that would not load, and another principal's run: none of them changed a file.
    await harness.callTool('workflows-pause', { id: 'digest', expectedHash: paused });
    await harness.callTool('workflows-resume', { id: 'digest', expectedHash: hash });
    await harness.callTool('workflows-create', { name: '!!!', trigger: TRIGGER, steps: STEPS });
    await harness.callTool('workflows-create', {
      name: 'Bad',
      trigger: { kind: 'x' },
      steps: STEPS,
    });
    await harness.callTool(
      'workflows-resume',
      { id: 'digest', expectedHash: paused },
      { principal: 'api-key:alice' },
    );

    expect(await trail(harness.bureau, 'digest')).toEqual(before);
    expect(await trail(harness.bureau, 'bad')).toEqual([]);
  });
});

describe('a write made over HTTP', () => {
  it('is an entry whose actor is the calling principal, including a delete', async () => {
    const served = await serveWorkflows(cleanups);
    const definition = { agent: 'writer', trigger: TRIGGER, steps: STEPS };

    const created = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'digest',
      definition,
    });
    const first = (created.result as { hash: string }).hash;
    const updated = await rpc(
      served.keyed,
      'bureau.workflows.update',
      {
        id: 'digest',
        expectedHash: first,
        definition: { ...definition, trigger: { kind: 'schedule', spec: '2h' } },
      },
      'workflows-writer-key',
    );
    const second = (updated.result as { hash: string }).hash;
    const paused = await ownerRpc(served.owner, 'bureau.workflows.pause', {
      id: 'digest',
      expectedHash: second,
    });
    const third = (paused.result as { hash: string }).hash;
    const resumed = await ownerRpc(served.owner, 'bureau.workflows.resume', {
      id: 'digest',
      expectedHash: third,
    });
    const fourth = (resumed.result as { hash: string }).hash;
    const deleted = await rpc(
      served.keyed,
      'bureau.workflows.delete',
      { id: 'digest', expectedHash: fourth },
      'operator-key',
    );
    expect(deleted.error).toBeUndefined();

    const entries = await trail(served.bureau, 'digest');
    expect(entries.map((entry) => [entry.type, entry.principal])).toEqual([
      ['workflow.created', 'anonymous:local'],
      ['workflow.updated', 'api-key:workflows-writer'],
      ['workflow.paused', 'anonymous:local'],
      ['workflow.resumed', 'anonymous:local'],
      ['workflow.deleted', 'api-key:operator'],
    ]);
    expect(entries.at(-1)?.detail).toEqual({ id: 'digest', hash: fourth });
  });

  it('is visible to the deployment’s owner and hidden from an API-key principal with no scope', async () => {
    const served = await serveWorkflows(cleanups);
    await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'digest',
      definition: { agent: 'writer', trigger: TRIGGER, steps: STEPS },
    });
    const [entry] =
      (await served.bureau.internals.auditTrail?.query({ runId: 'workflow:digest' })) ?? [];
    expect(entry?.type).toBe('workflow.created');
    const resourceOwner = await served.bureau.getOwner({
      kind: 'audit',
      runId: entry!.runId,
      detail: entry!.detail,
    });
    expect(resourceOwner).toBe(served.bureau.workflows!.owner);

    const owner = unauthenticatedLocalAuthContext().principal!;
    const alice = principalFromApiKey({ subject: 'alice', scopes: [] });
    const see = (principal: typeof owner) =>
      mayAccessOwnedResource({ principal, resourceOwner, operatorScope: 'bureau.workflows:read' });
    expect(see(owner)).toBe(true);
    expect(see(alice)).toBe(false);
  });
});
