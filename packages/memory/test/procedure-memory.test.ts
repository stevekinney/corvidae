import { MemoryStorage } from '@lostgradient/weft';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import type {
  EvidenceProjectionRecord,
  ProjectionReference,
} from '../src/evidence-projection-schema';
import { procedurePayload } from '../src/evidence-projection-schema';
import { digestOfText, type EvidenceRecord } from '../src/evidence-schema';
import {
  extractProcedureCandidate,
  type ProcedureCandidate,
  ProcedureCandidateError,
  type ProcedureDraft,
} from '../src/procedure-candidate';
import {
  ProcedureLifecycleError,
  recordProcedureOutcome,
  retireProcedure,
} from '../src/procedure-lifecycle';
import {
  type ProcedureReviewDecision,
  type ProcedureValidator,
  promoteProcedure,
} from '../src/procedure-promotion';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
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

const review = (approved: boolean, requestDigest = 'unset'): ProcedureReviewDecision => ({
  reviewId: 'review-1',
  requestDigest,
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
      const error = await rejectionOf(
        candidateFrom(3, 0, {
          steps: [{ kind: 'check', text: 'the run happened to succeed', causal: false }],
        }),
      );
      expect(error).toMatchObject({ code: 'no-causal-step' });
    });

    it('promotes a verified command sequence in one transition, recording its fixture and outcome', async () => {
      const candidate = await candidateFrom(2);
      const promotion = await promote(candidate, { validator: validator() });
      expect(promotion.status).toBe('promoted');
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(stored).toMatchObject({ kind: 'procedure', status: 'active' });
      if (stored?.kind !== 'procedure' || !('version' in stored.payload)) throw new Error('v2');
      expect(stored.payload.provenance.validation).toMatchObject({
        evaluator: { name: 'replay', revision: 'replay:1', kind: 'deterministic' },
        outcome: 'passed',
        observation: 'renewed; expires in 89 days',
        fixtureDigest: digestOfText('staging certificate expiring in 3 days'),
        observationDigest: digestOfText('renewed; expires in 89 days'),
      });
      // One receipt, whose record digest covers the payload and so the validation it carries.
      const receipt = await harness.engine.getReceipt(TENANT, 'promote-1');
      expect(receipt?.projections).toMatchObject([{ id: 'procedure-1', transition: 'created' }]);
    });

    it('refuses a candidate whose validation fails, and stores nothing', async () => {
      const promotion = await promote(await candidateFrom(2), { validator: validator('failed') });
      expect(promotion).toMatchObject({ status: 'refused', reason: 'validation-failed' });
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toBeUndefined();
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

      if (pending.status !== 'pending-review') throw new Error('pending');
      const { requestDigest } = pending.request;
      const declined = await promote(candidate, {
        validator: validator(),
        review: review(false, requestDigest),
      });
      expect(declined).toMatchObject({ status: 'refused', reason: 'review-declined' });

      // An approval decided for another request never carries over.
      const elsewhere = await promote(candidate, {
        validator: validator(),
        review: review(true, 'sha256:another-request'),
      });
      expect(elsewhere).toMatchObject({ status: 'refused', reason: 'review-mismatch' });
      const otherFixture = await promote(candidate, {
        validator: {
          ...validator(),
          validate: async () => ({ outcome: 'passed', fixture: 'other fixture', evidence: 'ok' }),
        },
        review: review(true, requestDigest),
      });
      expect(otherFixture).toMatchObject({ status: 'refused', reason: 'review-mismatch' });
      const approved = await promote(candidate, {
        validator: validator(),
        review: review(true, requestDigest),
      });
      expect(approved.status).toBe('promoted');
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(stored?.payload).toMatchObject({
        approval: { scope: 'high-impact', required: true },
        provenance: { review: { reviewId: 'review-1' } },
      });
    });

    it('refuses a hand-written high-impact procedure that skipped review, at the engine', async () => {
      const candidate = await candidateFrom(1, 0, { scope: 'high-impact' });
      const pending = await promote(candidate, { validator: validator() });
      if (pending.status !== 'pending-review') throw new Error('pending');
      const promotion = await promote(candidate, {
        validator: validator(),
        review: review(true, pending.request.requestDigest),
      });
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

    it('refuses a reviewer that is not a person before validating anything', async () => {
      const candidate = await candidateFrom(1, 0, { scope: 'high-impact' });
      const byAgent = await promote(candidate, {
        validator: validator(),
        review: { ...review(true), reviewer: { kind: 'agent', id: 'planner' } },
      });
      expect(byAgent).toMatchObject({ status: 'refused', reason: 'review-not-human' });
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toBeUndefined();
    });

    it('refuses a candidate extracted for another tenant', async () => {
      const candidate = await candidateFrom(1);
      const promotion = await promote(
        { ...candidate, tenantId: 'tenant-b' },
        { validator: validator() },
      );
      expect(promotion).toMatchObject({ status: 'refused', reason: 'wrong-tenant' });
    });

    it('stores the candidate that was validated, whatever the validator does to it meanwhile', async () => {
      const candidate = await candidateFrom(1, 0, { scope: 'high-impact' });
      const tampering: ProcedureValidator = {
        ...validator(),
        validate: async (seen) => {
          // A snapshot is frozen, so a validator cannot downgrade the scope it was shown.
          expect(Object.isFrozen(seen.draft)).toBe(true);
          return validator().validate(seen);
        },
      };
      const promotion = await promote(candidate, { validator: tampering });
      expect(promotion.status).toBe('pending-review');
      (candidate.draft as { scope: string }).scope = 'routine';
      expect(promotion).toMatchObject({ request: { scope: 'high-impact' } });
    });

    it('refuses to promote from an episode revoked since extraction', async () => {
      const candidate = await candidateFrom(1);
      harness.clock.advance(1000);
      const revoked = await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'revoke-episode',
        tenantId: TENANT,
        authority,
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'episode-0',
            expectedRevision: 1,
            change: { kind: 'revoked', reasonCode: 'poisoned' },
          },
        ],
      });
      expect(revoked.outcome).toBe('committed');
      const promotion = await promote(candidate, { validator: validator() });
      expect(promotion).toMatchObject({ status: 'refused', reason: 'episode-withdrawn' });
    });

    it('stores the sources the episodes rest on, never a candidate value’s claim', async () => {
      const candidate = await candidateFrom(1);
      const stray = makeInlineEvidence('stray', { text: 'Unrelated evidence.' });
      await harness.storage.commit({ tenantId: TENANT, evidence: [stray] });
      const promotion = await promote(
        { ...candidate, sources: [sourceOf(stray)] },
        { validator: validator() },
      );
      expect(promotion.status).toBe('promoted');
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(stored?.sources.map((source) => source.evidenceId)).toEqual(['run-0']);
    });

    it('records no review on a routine procedure, whatever decision accompanies it', async () => {
      const candidate = await candidateFrom(1);
      await promote(candidate, { validator: validator(), review: review(false, 'sha256:junk') });
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(stored?.payload).not.toHaveProperty('provenance.review');
    });

    it('refuses an episode named twice, or as both a success and a failure', async () => {
      const { successful } = await seedEpisodes(1);
      const error = await rejectionOf(
        extractProcedureCandidate({
          storage: harness.storage,
          tenantId: TENANT,
          namespace: NAMESPACE,
          draft: draft(),
          successfulEpisodes: successful,
          failedEpisodes: successful,
        }),
      );
      expect(error).toMatchObject({ code: 'contradictory-episodes' });
    });

    it('refuses a hand-written procedure whose observation digest does not match it, at the engine', async () => {
      await promote(await candidateFrom(1), { validator: validator() });
      const stored = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      if (stored?.kind !== 'procedure' || !('version' in stored.payload)) throw new Error('v2');
      const { provenance } = stored.payload;
      const result = await harness.engine.submit({
        kind: 'create-projection',
        operationId: 'forged-observation',
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
            payload: {
              ...stored.payload,
              provenance: {
                ...provenance,
                validation: { ...provenance.validation, observation: 'it all failed' },
              },
            },
          },
        ],
      });
      expect(JSON.stringify(result)).toContain('procedure.observation-digest');
    });

    it('binds an approval to the validator kind and the observation it saw', async () => {
      const candidate = await candidateFrom(1, 0, { scope: 'high-impact' });
      const pending = await promote(candidate, { validator: validator() });
      if (pending.status !== 'pending-review') throw new Error('pending');
      const approval = review(true, pending.request.requestDigest);
      const asEvaluator = await promote(candidate, {
        validator: { ...validator(), kind: 'evaluator' },
        review: approval,
      });
      expect(asEvaluator).toMatchObject({ status: 'refused', reason: 'review-mismatch' });
      const otherObservation = await promote(candidate, {
        validator: {
          ...validator(),
          validate: async () => ({
            outcome: 'passed',
            fixture: 'staging certificate expiring in 3 days',
            evidence: 'renewed; expires in 30 days',
          }),
        },
        review: approval,
      });
      expect(otherObservation).toMatchObject({ status: 'refused', reason: 'review-mismatch' });
    });

    it('decides on the review it was given, whatever happens to it while validation runs', async () => {
      const candidate = await candidateFrom(1, 0, { scope: 'high-impact' });
      const pending = await promote(candidate, { validator: validator() });
      if (pending.status !== 'pending-review') throw new Error('pending');
      const decision = { ...review(false, pending.request.requestDigest) };
      const flipping: ProcedureValidator = {
        ...validator(),
        validate: async (seen) => {
          (decision as { approved: boolean }).approved = true;
          return validator().validate(seen);
        },
      };
      const promotion = await promote(candidate, { validator: flipping, review: decision });
      expect(promotion).toMatchObject({ status: 'refused', reason: 'review-declined' });
    });

    it('replays a committed promotion even after one of its episodes was revoked', async () => {
      const candidate = await candidateFrom(1);
      const first = await promote(candidate, { validator: validator() });
      expect(first.status).toBe('promoted');
      harness.clock.advance(1000);
      await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'revoke-episode',
        tenantId: TENANT,
        authority,
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'episode-0',
            expectedRevision: 1,
            change: { kind: 'revoked', reasonCode: 'poisoned' },
          },
        ],
      });
      const retried = await promote(candidate, { validator: validator() });
      expect(retried).toMatchObject({
        status: 'promoted',
        result: { outcome: 'committed', replayed: true },
      });
    });

    it('refuses to retire anything but a procedure', async () => {
      await candidateFrom(1);
      harness.clock.advance(1000);
      const error = await rejectionOf(
        retireProcedure({
          engine: harness.engine,
          authority,
          namespace: NAMESPACE,
          procedure: { id: 'episode-0', revision: 1 },
          operationId: 'retire-1',
          change: 'revoke',
          reason: 'not-a-procedure',
        }),
      );
      expect(error).toBeInstanceOf(ProcedureLifecycleError);
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'episode-0')).toMatchObject({
        status: 'active',
      });
    });

    it('refuses to record an outcome against anything but a procedure', async () => {
      await candidateFrom(1);
      const error = await rejectionOf(
        recordProcedureOutcome({
          engine: harness.engine,
          authority,
          namespace: NAMESPACE,
          procedure: { id: 'episode-0', revision: 1 },
          operationId: 'outcome-1',
          episodeId: 'episode-failure-1',
          outcome: 'failed',
          summary: 'Not a procedure.',
          projectorRevision: 'episode-projector:1',
          at: harness.clock.now(),
        }),
      );
      expect(error).toBeInstanceOf(ProcedureLifecycleError);
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'episode-0')).toMatchObject({
        status: 'active',
      });
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
        at: harness.clock.now(),
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
        at: harness.clock.now(),
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

    it('replaces a validated procedure with a rebuilt revision, keeping the old one in history', async () => {
      await promote(await candidateFrom(1), { validator: validator() });
      harness.clock.advance(1000);
      const revalidated = await extractProcedureCandidate({
        storage: harness.storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        draft: draft({ environment: [{ name: 'certbot', version: '3.0' }] }),
        successfulEpisodes: [{ id: 'episode-0', revision: 1 }],
      });
      const replacement = await promote(revalidated, {
        validator: validator(),
        operationId: 'promote-2',
        replaces: 1,
      });
      expect(replacement).toMatchObject({
        status: 'promoted',
        procedure: { id: 'procedure-1', revision: 2 },
      });
      const current = await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1');
      expect(current).toMatchObject({
        revision: 2,
        status: 'active',
        transition: { kind: 'rebuilt', rebuiltFromRevision: 1 },
        payload: { environment: [{ name: 'certbot', version: '3.0' }] },
      });
      const previous = await harness.storage.getProjectionRevision(
        TENANT,
        NAMESPACE,
        'procedure-1',
        1,
      );
      expect(previous?.payload).toMatchObject({
        environment: [{ name: 'certbot', version: '2.11' }],
      });

      // Naming a revision that is no longer current is the engine's refusal, never a silent new procedure.
      const stale = await promote(revalidated, {
        validator: validator(),
        operationId: 'promote-3',
        replaces: 1,
      });
      expect(stale.status).toBe('rejected');
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'procedure-1')).toMatchObject({
        revision: 2,
      });
    });

    it('replays a retried promotion instead of writing it twice, even after the clock moved', async () => {
      const candidate = await candidateFrom(1);
      await promote(candidate, { validator: validator() });
      harness.clock.advance(60_000);
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
      at: clock.now(),
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
    });
    expect(replay).toMatchObject({ status: 'promoted' });
  });

  it('refuses an episode that no longer exists, so a candidate cannot rest on nothing', async () => {
    const harness = createHarness(TRANSITION_BACKENDS[0]![1]);
    const error = await rejectionOf(
      extractProcedureCandidate({
        storage: harness.storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        draft: draft(),
        successfulEpisodes: [{ id: 'missing', revision: 1 }],
      }),
    );
    expect(error).toBeInstanceOf(ProcedureCandidateError);
  });
});

describe('procedure payload versions (COR-770)', () => {
  it('still parses a procedure COR-769 stored, unchanged', () => {
    expect(procedurePayload.parse({ title: 'Deploy', steps: ['build', 'ship'] })).toEqual({
      title: 'Deploy',
      steps: ['build', 'ship'],
    });
  });

  it('requires a tool step to name its tool, and a reviewer to be a person', () => {
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
          observation: 'renewed',
          observationDigest: `sha256:${'1'.repeat(64)}`,
        },
      },
      scope: undefined,
      steps: [{ kind: 'tool', text: 'reload', causal: true, ...overrides }],
    });
    const { scope: _scope, ...valid } = step({ tool: 'reload_balancer' });
    expect(procedurePayload.safeParse(valid).success).toBe(true);
    const { scope: _missing, ...missing } = step({});
    expect(procedurePayload.safeParse(missing).success).toBe(false);
    // The persisted shape only admits a person as reviewer, so no proposal can carry an agent's.
    const reviewed = (kind: string) => ({
      ...valid,
      provenance: {
        ...valid.provenance,
        review: { reviewer: { kind, id: 'reviewer' }, decidedAt: 1, reviewId: 'review-1' },
      },
    });
    expect(procedurePayload.safeParse(reviewed('user')).success).toBe(true);
    expect(procedurePayload.safeParse(reviewed('agent')).success).toBe(false);
  });
});
