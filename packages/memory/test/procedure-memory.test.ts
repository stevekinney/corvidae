import { MemoryStorage } from '@lostgradient/weft';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import type {
  EvidenceProjectionRecord,
  ProjectionReference,
} from '../src/evidence-projection-schema';
import { procedurePayload } from '../src/evidence-projection-schema';
import type { EvidenceRecord } from '../src/evidence-schema';
import {
  extractProcedureCandidate,
  type ProcedureCandidate,
  ProcedureCandidateError,
  type ProcedureDraft,
} from '../src/procedure-candidate';
import { recordProcedureOutcome, retireProcedure } from '../src/procedure-lifecycle';
import {
  type ProcedureReviewDecision,
  type ProcedureValidator,
  promoteProcedure,
} from '../src/procedure-promotion';
import { createTransitionEngine, type TransitionEngine } from '../src/transition-engine';
import {
  FIXED_AT,
  makeInlineEvidence,
  NAMESPACE,
  sourceOf,
  TENANT,
} from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  createHarness,
  createManualClock,
  createRecordingSink,
  makeWriteAuthority,
  type TransitionHarness,
} from './transition-test-support';

const authority = makeWriteAuthority();

function episode(id: string, evidence: EvidenceRecord, summary: string): EvidenceProjectionRecord {
  return {
    schemaVersion: 1,
    id,
    tenantId: TENANT,
    namespace: NAMESPACE,
    kind: 'episode',
    revision: 1,
    projectorRevision: 'projector:1',
    policyRevision: 'policy:1',
    sources: [sourceOf(evidence)],
    validity: { validFrom: FIXED_AT },
    confidence: 0.9,
    status: 'active',
    transition: { kind: 'created', at: FIXED_AT },
    payload: { summary, occurredFrom: FIXED_AT },
  };
}

const draft = (overrides: Partial<ProcedureDraft> = {}): ProcedureDraft => ({
  title: 'Rotate the staging certificate',
  objective: 'Replace the expiring TLS certificate on staging.',
  taskClass: 'certificate-rotation',
  preconditions: ['the certificate expires within 14 days'],
  requiredCapabilities: ['tools:execute'],
  environment: [{ name: 'certbot', version: '2.11' }],
  steps: [
    { kind: 'command', text: 'certbot renew --cert-name staging', causal: true },
    { kind: 'tool', text: 'reload the load balancer', tool: 'reload_balancer', causal: true },
    { kind: 'check', text: 'curl the health endpoint', causal: false },
  ],
  expectedEvidence: ['a renewed certificate with a new expiry'],
  postconditions: ['the certificate expires in more than 60 days'],
  knownFailures: [{ signature: 'rate limit exceeded', remedy: 'wait an hour' }],
  sideEffects: [],
  scope: 'routine',
  ...overrides,
});

/** A validator that replays the fixture and reports what it was told to. */
function validator(outcome: 'passed' | 'failed' = 'passed'): ProcedureValidator {
  return {
    name: 'replay',
    revision: 'replay:1',
    kind: 'deterministic',
    validate: async () => ({
      outcome,
      fixture: 'staging certificate expiring in 3 days',
      evidence: outcome === 'passed' ? 'renewed; expires in 89 days' : 'rate limit exceeded',
    }),
  };
}

const review = (approved: boolean): ProcedureReviewDecision => ({
  reviewId: 'review-1',
  reviewer: { kind: 'user', id: 'reviewer-1' },
  approved,
  decidedAt: FIXED_AT + 10,
});

/**
 * COR-770 — validated procedural memory over evidence and projections:
 * extraction from episodes, promotion only through a validator (and a reviewer
 * for high-impact procedures), and a lifecycle that changes a procedure only
 * through ordinary transitions.
 */
for (const [backend, makeBackend] of TRANSITION_BACKENDS) {
  describe(`validated procedural memory (${backend})`, () => {
    let harness: TransitionHarness;

    async function seedEpisodes(count: number, failures = 0) {
      const successful: ProjectionReference[] = [];
      const failed: ProjectionReference[] = [];
      for (let index = 0; index < count + failures; index += 1) {
        const evidence = makeInlineEvidence(`run-${index}`, { text: `Run ${index} transcript.` });
        const id = `episode-${index}`;
        await harness.storage.commit({
          tenantId: TENANT,
          evidence: [evidence],
          projections: [
            episode(id, evidence, `Run ${index} ${index < count ? 'worked' : 'failed'}.`),
          ],
        });
        (index < count ? successful : failed).push({ id, revision: 1 });
      }
      return { successful, failed };
    }

    async function candidateFrom(
      count: number,
      failures = 0,
      overrides: Partial<ProcedureDraft> = {},
    ): Promise<ProcedureCandidate> {
      const episodes = await seedEpisodes(count, failures);
      return extractProcedureCandidate({
        storage: harness.storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        draft: draft(overrides),
        successfulEpisodes: episodes.successful,
        failedEpisodes: episodes.failed,
      });
    }

    const promote = (
      candidate: ProcedureCandidate,
      overrides: Partial<Parameters<typeof promoteProcedure>[0]> = {},
    ) =>
      promoteProcedure({
        engine: harness.engine,
        authority,
        candidate,
        id: 'procedure-1',
        operationId: 'promote-1',
        projectorRevision: 'procedure-projector:1',
        now: harness.clock.now,
        ...overrides,
      });

    beforeEach(() => {
      harness = createHarness(makeBackend);
    });

    it('links a candidate to its successful and failed episodes and their evidence', async () => {
      const candidate = await candidateFrom(2, 1);
      expect(candidate.successfulEpisodes.map((reference) => reference.id)).toEqual([
        'episode-0',
        'episode-1',
      ]);
      expect(candidate.failedEpisodes.map((reference) => reference.id)).toEqual(['episode-2']);
      expect(candidate.sources.map((source) => source.evidenceId)).toEqual([
        'run-0',
        'run-1',
        'run-2',
      ]);
    });

    it('never promotes a bare success count: many successes and no validator are refused', async () => {
      const candidate = await candidateFrom(25);
      const promotion = await promote(candidate);
      expect(promotion).toMatchObject({ status: 'refused', reason: 'unvalidated' });
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toBeUndefined();
    });

    it('refuses a draft whose only claimed success is a step that caused nothing', async () => {
      await expect(
        candidateFrom(3, 0, {
          steps: [{ kind: 'check', text: 'the run happened to succeed', causal: false }],
        }),
      ).rejects.toMatchObject({ code: 'no-causal-step' });
    });

    it('promotes a verified command sequence and records the fixture and outcome evidence', async () => {
      const candidate = await candidateFrom(2);
      const promotion = await promote(candidate, { validator: validator() });
      expect(promotion.status).toBe('promoted');
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(stored).toMatchObject({ kind: 'procedure', status: 'active' });
      if (stored?.kind !== 'procedure' || !('version' in stored.payload)) throw new Error('v2');
      const { validation } = stored.payload.provenance;
      expect(validation).toMatchObject({
        evaluator: { name: 'replay', revision: 'replay:1', kind: 'deterministic' },
        outcome: 'passed',
        outcomeEvidenceId: 'promote-1:validation',
      });
      expect(validation.fixtureDigest).toStartWith('sha256:');
      expect(stored.sources.map((source) => source.evidenceId)).toContain('promote-1:validation');
      const outcome = await harness.storage.getEvidence(TENANT, 'promote-1:validation');
      expect(outcome).toMatchObject({ kind: 'tool-result', trustTier: 'verified' });
      // Both receipts are stored: the outcome evidence's, and the procedure's, whose
      // record digest covers the sources it rests on, the outcome evidence among them.
      const evidenceReceipt = await harness.engine.getReceipt(TENANT, 'promote-1:validation');
      expect(JSON.stringify(evidenceReceipt)).toContain('promote-1:validation');
      const receipt = await harness.engine.getReceipt(TENANT, 'promote-1');
      expect(receipt?.projections).toMatchObject([{ id: 'procedure-1', transition: 'created' }]);
    });

    it('refuses a candidate whose validation fails, and stores nothing', async () => {
      const promotion = await promote(await candidateFrom(2), { validator: validator('failed') });
      expect(promotion).toMatchObject({ status: 'refused', reason: 'validation-failed' });
      expect(await harness.storage.getEvidence(TENANT, 'promote-1:validation')).toBeUndefined();
    });

    it('routes a high-impact promotion through a required human review', async () => {
      const candidate = await candidateFrom(2, 0, {
        scope: 'high-impact',
        sideEffects: ['restarts the production balancer'],
      });
      const pending = await promote(candidate, { validator: validator() });
      expect(pending).toMatchObject({
        status: 'pending-review',
        request: { procedureId: 'procedure-1', scope: 'high-impact' },
      });
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toBeUndefined();

      const declined = await promote(candidate, { validator: validator(), review: review(false) });
      expect(declined).toMatchObject({ status: 'refused', reason: 'review-declined' });

      const approved = await promote(candidate, { validator: validator(), review: review(true) });
      expect(approved.status).toBe('promoted');
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(stored?.payload).toMatchObject({
        approval: { scope: 'high-impact', required: true },
        provenance: { review: { reviewId: 'review-1' } },
      });
    });

    it('refuses a hand-written high-impact procedure that skipped review, at the engine', async () => {
      const candidate = await candidateFrom(1, 0, { scope: 'high-impact' });
      const promotion = await promote(candidate, { validator: validator(), review: review(true) });
      expect(promotion.status).toBe('promoted');
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      if (stored?.kind !== 'procedure' || !('version' in stored.payload)) throw new Error('v2');
      const { review: _skipped, ...provenance } = stored.payload.provenance;
      const result = await harness.engine.submit({
        kind: 'create-projection',
        operationId: 'forged',
        tenantId: TENANT,
        authority,
        projections: [
          {
            id: 'procedure-forged',
            tenantId: TENANT,
            namespace: NAMESPACE,
            kind: 'procedure',
            projectorRevision: 'procedure-projector:1',
            sources: stored.sources,
            confidence: 0.5,
            payload: { ...stored.payload, provenance },
          },
        ],
      });
      expect(result).toMatchObject({ outcome: 'rejected', reason: 'type-invariant-violated' });
      expect(JSON.stringify(result)).toContain('procedure.high-impact-reviewed');
    });

    it('demotes a promoted procedure that fails, recording the failure as a new episode', async () => {
      await promote(await candidateFrom(2), { validator: validator() });
      const record = await recordProcedureOutcome({
        engine: harness.engine,
        authority,
        namespace: NAMESPACE,
        procedure: { id: 'procedure-1', revision: 1 },
        operationId: 'outcome-1',
        episodeId: 'episode-failure-1',
        outcome: 'failed',
        summary: 'Renewal hit the rate limit.',
        failureSignature: 'rate limit exceeded',
        projectorRevision: 'episode-projector:1',
        now: harness.clock.now,
      });
      expect(record.demoted).toBe(true);
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(stored).toMatchObject({
        revision: 2,
        status: 'demoted',
        transition: { kind: 'demoted', demotedBy: { id: 'episode-failure-1', revision: 1 } },
      });
      // The procedure's payload is never edited: revision 1 is still the promoted text.
      const original = await harness.storage.getProjectionRevision(
        TENANT,
        NAMESPACE,
        'procedure-1',
        1,
      );
      expect(original?.payload).toEqual(stored?.payload);
    });

    it('records a success without demoting', async () => {
      await promote(await candidateFrom(1), { validator: validator() });
      const record = await recordProcedureOutcome({
        engine: harness.engine,
        authority,
        namespace: NAMESPACE,
        procedure: { id: 'procedure-1', revision: 1 },
        operationId: 'outcome-1',
        episodeId: 'episode-success-1',
        outcome: 'succeeded',
        summary: 'Renewed cleanly.',
        projectorRevision: 'episode-projector:1',
        now: harness.clock.now,
      });
      expect(record.demoted).toBe(false);
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toMatchObject({
        status: 'active',
      });
    });

    it('quarantines and revokes through ordinary transitions', async () => {
      await promote(await candidateFrom(1), { validator: validator() });
      harness.clock.advance(1000);
      const quarantined = await retireProcedure({
        engine: harness.engine,
        authority,
        namespace: NAMESPACE,
        procedure: { id: 'procedure-1', revision: 1 },
        operationId: 'quarantine-1',
        change: 'quarantine',
        reason: 'suspected-poisoning',
      });
      expect(quarantined.outcome).toBe('committed');
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toMatchObject({
        status: 'revoked',
        transition: { kind: 'revoked', reasonCode: 'quarantined:suspected-poisoning' },
      });
    });

    it('supersedes a validated procedure atomically with its replacement', async () => {
      await promote(await candidateFrom(1), { validator: validator() });
      harness.clock.advance(1000);
      const replacement = await promote(
        await extractProcedureCandidate({
          storage: harness.storage,
          tenantId: TENANT,
          namespace: NAMESPACE,
          draft: draft({ environment: [{ name: 'certbot', version: '3.0' }] }),
          successfulEpisodes: [{ id: 'episode-0', revision: 1 }],
        }),
        {
          validator: validator(),
          id: 'procedure-2',
          operationId: 'promote-2',
          supersedes: { id: 'procedure-1', revision: 1 },
        },
      );
      expect(replacement.status).toBe('promoted');
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toMatchObject({
        status: 'superseded',
        transition: { kind: 'superseded', supersededBy: { id: 'procedure-2', revision: 1 } },
      });
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-2')).toMatchObject({
        status: 'active',
        transition: { kind: 'created', supersedes: [{ id: 'procedure-1', revision: 1 }] },
      });
    });

    it('replays a retried promotion instead of writing it twice', async () => {
      const candidate = await candidateFrom(1);
      await promote(candidate, { validator: validator() });
      const again = await promote(candidate, { validator: validator() });
      expect(again.status).toBe('promoted');
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(stored?.revision).toBe(1);
    });
  });
}

describe('procedure state across a process restart (COR-770)', () => {
  it('recovers a promoted, then demoted, procedure from durable storage', async () => {
    const durable = new MemoryStorage();
    const clock = createManualClock();
    const open = (): TransitionEngine =>
      createTransitionEngine({
        storage: createWeftEvidenceProjectionStorage(durable),
        sink: createRecordingSink().sink,
        now: clock.now,
      });
    const first = open();
    const evidence = makeInlineEvidence('run-0', { text: 'Run 0 transcript.' });
    await first.storage.commit({
      tenantId: TENANT,
      evidence: [evidence],
      projections: [episode('episode-0', evidence, 'Run 0 worked.')],
    });
    const candidate = await extractProcedureCandidate({
      storage: first.storage,
      tenantId: TENANT,
      namespace: NAMESPACE,
      draft: draft(),
      successfulEpisodes: [{ id: 'episode-0', revision: 1 }],
    });
    await promoteProcedure({
      engine: first,
      authority,
      candidate,
      id: 'procedure-1',
      operationId: 'promote-1',
      projectorRevision: 'procedure-projector:1',
      validator: validator(),
      now: clock.now,
    });

    // A new process: a new engine and store over the same durable state.
    const restarted = open();
    expect(await restarted.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toMatchObject({
      status: 'active',
    });
    const record = await recordProcedureOutcome({
      engine: restarted,
      authority,
      namespace: NAMESPACE,
      procedure: { id: 'procedure-1', revision: 1 },
      operationId: 'outcome-1',
      episodeId: 'episode-failure-1',
      outcome: 'failed',
      summary: 'It failed after the restart.',
      projectorRevision: 'episode-projector:1',
      now: clock.now,
    });
    expect(record.demoted).toBe(true);
    const third = open();
    expect(await third.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toMatchObject({
      status: 'demoted',
      revision: 2,
    });
    // A retried promotion after the restart replays its receipt rather than writing again.
    const replay = await promoteProcedure({
      engine: third,
      authority,
      candidate,
      id: 'procedure-1',
      operationId: 'promote-1',
      projectorRevision: 'procedure-projector:1',
      validator: validator(),
      now: clock.now,
    });
    expect(replay).toMatchObject({ status: 'promoted' });
  });

  it('refuses an episode that no longer exists, so a candidate cannot rest on nothing', async () => {
    const harness = createHarness(TRANSITION_BACKENDS[0]![1]);
    await expect(
      extractProcedureCandidate({
        storage: harness.storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        draft: draft(),
        successfulEpisodes: [{ id: 'missing', revision: 1 }],
      }),
    ).rejects.toBeInstanceOf(ProcedureCandidateError);
  });
});

describe('procedure payload versions (COR-770)', () => {
  it('still parses a procedure COR-769 stored, unchanged', () => {
    expect(procedurePayload.parse({ title: 'Deploy', steps: ['build', 'ship'] })).toEqual({
      title: 'Deploy',
      steps: ['build', 'ship'],
    });
  });

  it('requires a tool step to name its tool, and no other step to', () => {
    const step = (overrides: Record<string, unknown>) => ({
      ...draft(),
      version: 2,
      approval: { scope: 'routine', required: false },
      provenance: {
        successfulEpisodes: [],
        failedEpisodes: [],
        validation: {
          evaluator: { name: 'replay', revision: 'replay:1', kind: 'deterministic' },
          fixtureDigest: `sha256:${'0'.repeat(64)}`,
          outcome: 'passed',
          outcomeEvidenceId: 'evidence-1',
        },
      },
      scope: undefined,
      steps: [{ kind: 'tool', text: 'reload', causal: true, ...overrides }],
    });
    const { scope: _scope, ...valid } = step({ tool: 'reload_balancer' });
    expect(procedurePayload.safeParse(valid).success).toBe(true);
    const { scope: _missing, ...missing } = step({});
    expect(procedurePayload.safeParse(missing).success).toBe(false);
  });
});
