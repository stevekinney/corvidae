/**
 * COR-770 — validated procedural memory through public APIs, end to end: a
 * procedure is proposed from an episode, validated, retrieved for a run's
 * environment, applied by a Bureau agent through its ordinary toolbox and tool
 * policy, recorded, and revoked. Procedure text grants nothing: a step naming a
 * tool the policy denies never runs.
 */
import {
  type AgentSkillDescriptor,
  createAgent,
  createPolicyEnforcementHook,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import {
  createMemoryAuthority,
  createTransitionEngine,
  createWeftEvidenceProjectionStorage,
  extractProcedureCandidate,
  type ProcedureMatch,
  type ProcedureValidator,
  promoteProcedure,
  recordProcedureOutcome,
  retireProcedure,
  retrieveProcedures,
} from '@lostgradient/memory';
import { MemoryStorage } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForRunState } from './test';
import type { Bureau } from './types';

const TENANT = 'tenant-a';
const NAMESPACE = 'runbooks';
const START = Date.parse('2026-01-01T00:00:00.000Z');

const authority = createMemoryAuthority({
  principal: { kind: 'user', id: 'operator-1' },
  tenantId: TENANT,
  ownerId: 'owner-1',
  purpose: 'procedural-memory',
  capabilities: ['memory:write', 'memory:search', 'memory:revoke'],
  policyRevision: 'authorization:1',
  projection: 'bureau',
});

const validator: ProcedureValidator = {
  name: 'staging-replay',
  revision: 'staging-replay:1',
  kind: 'deterministic',
  validate: async () => ({
    outcome: 'passed',
    fixture: 'staging certificate expiring in 3 days',
    evidence: 'renewed; expires in 89 days',
  }),
};

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

describe('a procedure from proposal to revocation through public APIs (COR-770)', () => {
  it('proposes, validates, retrieves, applies under tool policy, records, and revokes', async () => {
    let now = START;
    const clock = () => now;
    const engine = createTransitionEngine({
      storage: createWeftEvidenceProjectionStorage(new MemoryStorage()),
      sink: () => {},
      now: clock,
    });

    // An episode the procedure is extracted from, written through the transition engine.
    const text = 'Renewed the staging certificate and reloaded the balancer.';
    const digest = `sha256:${new Bun.CryptoHasher('sha256').update(text).digest('hex')}`;
    await engine.submit({
      kind: 'append-evidence',
      operationId: 'evidence-1',
      tenantId: TENANT,
      authority,
      evidence: [
        {
          schemaVersion: 1,
          id: 'run-1-transcript',
          tenantId: TENANT,
          ownerId: 'owner-1',
          kind: 'conversation',
          sourceLocator: 'run:run-1',
          content: { kind: 'inline', text },
          digest,
          producer: { kind: 'agent', id: 'operator-agent' },
          principal: { kind: 'user', id: 'operator-1' },
          trustTier: 'untrusted',
          eventAt: START,
          observedAt: START,
          classification: 'internal',
          authorizationScope: { visibility: 'private', sharedWith: [] },
          retention: { kind: 'subject-deletable' },
        },
      ],
    });
    await engine.submit({
      kind: 'create-projection',
      operationId: 'episode-1',
      tenantId: TENANT,
      authority,
      projections: [
        {
          id: 'episode-1',
          tenantId: TENANT,
          namespace: NAMESPACE,
          kind: 'episode',
          projectorRevision: 'episode-projector:1',
          sources: [{ evidenceId: 'run-1-transcript', digest }],
          confidence: 1,
          payload: { summary: text, occurredFrom: START },
          validity: { validFrom: START },
        },
      ],
    });

    // Propose and validate.
    const candidate = await extractProcedureCandidate({
      storage: engine.storage,
      tenantId: TENANT,
      namespace: NAMESPACE,
      draft: {
        title: 'Rotate the staging certificate',
        objective: 'Replace the expiring TLS certificate on staging.',
        taskClass: 'certificate-rotation',
        preconditions: [],
        requiredCapabilities: ['tools:execute'],
        environment: [{ name: 'certbot', version: '2.11' }],
        steps: [
          { kind: 'tool', text: 'renew the certificate', tool: 'renew_certificate', causal: true },
          { kind: 'tool', text: 'reload the load balancer', tool: 'reload_balancer', causal: true },
        ],
        expectedEvidence: ['a renewed certificate'],
        postconditions: ['the certificate expires in more than 60 days'],
        knownFailures: [{ signature: 'rate limit exceeded' }],
        sideEffects: [],
        scope: 'routine',
      },
      successfulEpisodes: [{ id: 'episode-1', revision: 1 }],
    });
    const promotion = await promoteProcedure({
      engine,
      authority,
      candidate,
      id: 'rotate-staging-certificate',
      operationId: 'promote-1',
      projectorRevision: 'procedure-projector:1',
      validator,
    });
    expect(promotion.status).toBe('promoted');

    // A portable skill references the procedure by id; neither record is rewritten into the other.
    const skill: AgentSkillDescriptor = {
      id: 'certificate-rotation',
      name: 'Certificate rotation',
      description: 'Rotates certificates by following a validated procedure.',
      tags: [`procedure:${NAMESPACE}/rotate-staging-certificate`],
    };
    const skillBefore = structuredClone(skill);

    // Retrieve for this run's environment; a newer certbot still fits, an older one does not.
    const retrieve = (environment: { name: string; version: string }[]) =>
      retrieveProcedures({
        storage: engine.storage,
        authority,
        namespace: NAMESPACE,
        query: 'rotate the staging certificate',
        environment,
        capabilities: ['tools:execute'],
        now: clock,
      });
    const mismatch = await retrieve([{ name: 'certbot', version: '2.10.1' }]);
    expect(mismatch.matches).toEqual([]);
    expect(mismatch.exclusions.map((item) => item.reason)).toEqual(['environment-mismatch']);
    const retrieval = await retrieve([{ name: 'certbot', version: '2.11.4' }]);
    const [match] = retrieval.matches;
    if (match === undefined) throw new Error('the procedure was not retrieved');

    // Apply it: the agent calls each tool step, through a toolbox the tool policy filtered.
    const ran: string[] = [];
    const tool = (name: string) =>
      createTool({
        name,
        description: `${name} for staging`,
        input: z.object({}),
        execute: async () => {
          ran.push(name);
          return 'ok';
        },
      });
    const allowed = createPolicyEnforcementHook({
      personaToolPolicy: { denyList: ['reload_balancer'] },
    })([tool('renew_certificate'), tool('reload_balancer')]);
    const applying =
      (procedure: ProcedureMatch): GenerateFunction =>
      async (context) =>
        context.step === 0
          ? {
              content: '',
              toolCalls: procedure.payload.steps.flatMap((step, index) =>
                step.tool === undefined
                  ? []
                  : [{ id: `call-${index}`, name: step.tool, arguments: {} }],
              ),
            }
          : { content: 'applied', toolCalls: [] };
    const bureau = await createBureau<AgentDefinitions>({
      id: TENANT,
      agents: {
        operator: createAgent({
          generate: applying(match),
          toolbox: createToolbox(allowed),
          skillDescriptors: [skill],
        }),
        default: createAgent({ stopWhen: stopWhen.noToolCalls() }),
      },
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({
      message: 'Rotate the staging certificate.',
      sessionId: 'session-1',
      agentName: 'operator',
    });
    await waitForRunState(bureau, run.id);
    // The procedure named reload_balancer, but the policy denied it, so it never ran.
    expect(ran).toEqual(['renew_certificate']);

    // Record the outcome: the denied step means the procedure did not complete, so it is demoted.
    now += 1000;
    const outcome = await recordProcedureOutcome({
      engine,
      authority,
      namespace: NAMESPACE,
      procedure: match.procedure,
      operationId: 'outcome-1',
      episodeId: 'episode-outcome-1',
      outcome: 'failed',
      failureSignature: 'reload_balancer denied by tool policy',
      summary: 'The balancer reload was denied, so the rotation did not complete.',
      projectorRevision: 'episode-projector:1',
      at: now,
    });
    expect(outcome.demoted).toBe(true);

    // Revoke it; it no longer comes back.
    now += 1000;
    const revoked = await retireProcedure({
      engine,
      authority,
      namespace: NAMESPACE,
      procedure: { id: match.procedure.id, revision: match.procedure.revision + 1 },
      operationId: 'revoke-1',
      change: 'revoke',
      reason: 'superseded-by-new-runbook',
    });
    expect(revoked.outcome).toBe('committed');
    const afterRevocation = await retrieve([{ name: 'certbot', version: '2.11.4' }]);
    expect(afterRevocation.matches).toEqual([]);

    expect(skill).toEqual(skillBefore);
    const stored = await engine.storage.getProjectionRevision(
      TENANT,
      NAMESPACE,
      'rotate-staging-certificate',
      1,
    );
    expect(Object.keys(stored?.payload ?? {})).not.toContain('tags');
    expect(stored?.kind).toBe('procedure');
  });
});
