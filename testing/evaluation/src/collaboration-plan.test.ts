import { describe, expect, test } from 'bun:test';

import {
  collaborationMessageSchema,
  collaborationPlanDigest,
  collaborationPlanSchema,
  EXECUTION_PROFILES,
  isExtensionTaskClass,
  MESSAGE_INTENTS,
  parseCollaborationPlan,
  TASK_CLASSES,
  taskClassKey,
} from './collaboration-plan';
import { EvaluatorConfigurationError } from './configuration';
import {
  directCollaborationPlanInput,
  directPlanInput,
  ensemblePlanInput,
  partitionedSearchPlanInput,
  type PlanInput,
  planInput,
  sharedStatePlanInput,
  verifierRevisionPlanInput,
} from './fixtures/comparison/plans';

function issuesOf(input: unknown): { path: string; message: string }[] {
  const parsed = collaborationPlanSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function paths(input: unknown): string[] {
  return issuesOf(input).map((issue) => issue.path);
}

function edit(plan: PlanInput, change: (plan: Record<string, any>) => void): PlanInput {
  change(plan);
  return plan;
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'observation',
    sender: 'searcher-a',
    recipient: 'reducer',
    relationship: 'peer',
    source: 'shard-a',
    trustClass: 'untrusted-claim',
    schema: 'finding-1',
    subject: 'answer',
    provenance: 'epoch-1',
    correlation: 'handoff-1',
    ...overrides,
  };
}

describe('the CollaborationPlan schema (COR-820)', () => {
  test('names the six task classes, three execution profiles, and nine message intents the decision fixes', () => {
    expect(TASK_CLASSES).toEqual([
      'direct',
      'independent-sampling',
      'partitioned-search',
      'sequential-dependency',
      'shared-state',
      'verifier-revision',
    ]);
    expect(EXECUTION_PROFILES).toEqual([
      'direct-agent',
      'compute-matched-ensemble',
      'collaboration',
    ]);
    expect(MESSAGE_INTENTS).toEqual([
      'observation',
      'hypothesis',
      'request',
      'proposal',
      'artifact',
      'verification-result',
      'commit',
      'rejection',
      'cancellation',
    ]);
  });

  test('parses every fixture plan, one per profile and class', () => {
    for (const plan of [
      directPlanInput('direct'),
      ensemblePlanInput('partitioned-search', ['sampler-1', 'sampler-2', 'sampler-3', 'sampler-4']),
      ensemblePlanInput(
        'partitioned-search',
        ['sampler-1', 'sampler-2', 'sampler-3'],
        'aggregator',
      ),
      partitionedSearchPlanInput(),
      directCollaborationPlanInput(),
      sharedStatePlanInput(),
      verifierRevisionPlanInput(),
      // The controls for a verifier-revision task have no producer-verifier cycle to bound.
      directPlanInput('verifier-revision'),
      ensemblePlanInput('verifier-revision', ['sampler-1', 'sampler-2']),
    ]) {
      expect(issuesOf(plan)).toEqual([]);
      expect(parseCollaborationPlan(plan)).toEqual(plan as never);
    }
  });

  test('carries no agentRevision: participant identity is agentName plus capabilityEvidence', () => {
    const plan = edit(partitionedSearchPlanInput(), (draft) => {
      draft['participants'][0].agentRevision = 3;
    });
    expect(paths(plan)).toEqual(['participants.0']);
  });

  test('accepts an explicitly named extension class only with a fully authored topology', () => {
    const extension = { extension: 'managed-goal-review', reason: 'Goal review is its own shape.' };
    const authored = edit(
      planInput({
        planId: 'extension-plan',
        taskClass: extension,
        executionProfile: 'collaboration',
        participants: [
          { agentName: 'proposer', role: 'producer' },
          { agentName: 'reviewer', role: 'verifier' },
        ],
        commitAuthority: 'proposer',
        permittedCycles: 1,
        edges: [
          { from: 'proposer', to: 'reviewer' },
          { from: 'reviewer', to: 'proposer' },
        ],
      }),
      (draft) => {
        draft['topology'].defaultForClass = false;
      },
    );
    expect(issuesOf(authored)).toEqual([]);
    expect(isExtensionTaskClass(extension)).toBe(true);
    expect(isExtensionTaskClass('direct')).toBe(false);
    expect(taskClassKey(extension)).toBe('extension:managed-goal-review');
    expect(taskClassKey('shared-state')).toBe('shared-state');

    const inherited = edit(structuredClone(authored), (draft) => {
      draft['topology'].defaultForClass = true;
    });
    expect(issuesOf(inherited)).toEqual([
      {
        path: 'topology.defaultForClass',
        message:
          'An extension class has no default topology; author it and set defaultForClass to false',
      },
    ]);
  });

  test('rejects a participant named twice and every reference to a participant the plan does not declare', () => {
    const plan = edit(partitionedSearchPlanInput(), (draft) => {
      draft['participants'].push({ ...draft['participants'][0] });
      draft['topology'].edges.push({ from: 'ghost', to: 'reducer', reason: 'Unknown sender.' });
      draft['topology'].edges.push({
        from: 'reducer',
        to: 'phantom',
        reason: 'Unknown recipient.',
      });
      draft['contextProjections'][0].participant = 'ghost';
      draft['artifacts'][0].owner = 'ghost';
      draft['artifacts'][0].readers.push('ghost');
      draft['artifacts'][0].writers.push('ghost');
      draft['artifacts'][0].commitAuthority = 'ghost';
      draft['commitAuthority'] = 'ghost';
      draft['lifecycle'].cancellationOwner = 'ghost';
      draft['stageVerifiers'] = [
        {
          stageId: 'reduce',
          boundAt: 'handoff-creation',
          acceptanceCriteria: 'Every shard reported.',
          rejector: ['ghost'],
          onFailure: 'terminal',
          retryBudget: 0,
        },
      ];
    });
    expect(issuesOf(plan)).toEqual([
      { path: 'participants.4.agentName', message: 'Duplicate participant "searcher-a"' },
      { path: 'topology.edges.3.from', message: 'Unknown participant "ghost"' },
      { path: 'topology.edges.4.to', message: 'Unknown participant "phantom"' },
      { path: 'contextProjections.0.participant', message: 'Unknown participant "ghost"' },
      { path: 'artifacts.0.owner', message: 'Unknown participant "ghost"' },
      { path: 'artifacts.0.readers.1', message: 'Unknown participant "ghost"' },
      { path: 'artifacts.0.writers.1', message: 'Unknown participant "ghost"' },
      { path: 'artifacts.0.commitAuthority', message: 'Unknown participant "ghost"' },
      { path: 'stageVerifiers.0.rejector.0', message: 'Unknown participant "ghost"' },
      { path: 'commitAuthority', message: 'Unknown participant "ghost"' },
      { path: 'lifecycle.cancellationOwner', message: 'Unknown participant "ghost"' },
    ]);
  });

  test('rejects duplicate projections, artifacts, schemas, and stages, and a required source it never names', () => {
    const plan = edit(partitionedSearchPlanInput(), (draft) => {
      draft['contextProjections'].push({ ...draft['contextProjections'][0] });
      draft['contextProjections'][1].requiredSources.push('shard-z');
      draft['artifacts'].push({ ...draft['artifacts'][0] });
      draft['messageSchemas'].push({ ...draft['messageSchemas'][0] });
      const stage = {
        stageId: 'reduce',
        boundAt: 'handoff-creation',
        acceptanceCriteria: 'Every shard reported.',
        rejector: ['reducer'],
        onFailure: 'escalate',
        retryBudget: 1,
      };
      draft['stageVerifiers'] = [stage, { ...stage }];
    });
    expect(issuesOf(plan)).toEqual([
      {
        path: 'contextProjections.1.requiredSources.1',
        message: 'Required source "shard-z" is not one of this projection\'s sources',
      },
      {
        path: 'contextProjections.3.participant',
        message: 'Duplicate context projection participant "searcher-a"',
      },
      { path: 'artifacts.1.artifactId', message: 'Duplicate artifact id "answer"' },
      { path: 'messageSchemas.2.schemaId', message: 'Duplicate message schema id "finding-1"' },
      { path: 'stageVerifiers.1.stageId', message: 'Duplicate stage verifier id "reduce"' },
    ]);
  });

  test('binds every stage verifier at handoff creation, never later', () => {
    const plan = edit(verifierRevisionPlanInput(), (draft) => {
      draft['stageVerifiers'][0].boundAt = 'after-completion';
    });
    expect(paths(plan)).toEqual(['stageVerifiers.0.boundAt']);
  });

  test('falls back only to one strong direct Agent', () => {
    const plan = edit(partitionedSearchPlanInput(), (draft) => {
      draft['fallback'].profile = 'compute-matched-ensemble';
    });
    expect(paths(plan)).toEqual(['fallback.profile']);
  });

  test('permits cycles only for verifier-driven revision or an extension, and requires them there', () => {
    const cyclic = edit(partitionedSearchPlanInput(), (draft) => {
      draft['topology'].permittedCycles = 1;
      draft['topology'].edges.push({ from: 'reducer', to: 'searcher-a', reason: 'Asks again.' });
    });
    expect(issuesOf(cyclic)).toEqual([
      {
        path: 'topology.permittedCycles',
        message:
          'Only a verifier-revision or extension plan may permit cycles; a partitioned-search plan permits 0',
      },
    ]);

    const undeclared = edit(partitionedSearchPlanInput(), (draft) => {
      draft['topology'].edges.push({ from: 'reducer', to: 'searcher-a', reason: 'Asks again.' });
    });
    expect(issuesOf(undeclared)).toEqual([
      {
        path: 'topology.edges',
        message: 'The edges form a cycle through "searcher-a", but the plan permits no cycles',
      },
    ]);

    const acyclicRevision = edit(verifierRevisionPlanInput(), (draft) => {
      draft['topology'].permittedCycles = 0;
      draft['topology'].edges = [draft['topology'].edges[0]];
      draft['stageVerifiers'] = [];
    });
    expect(issuesOf(acyclicRevision)).toEqual([
      {
        path: 'topology.permittedCycles',
        message:
          'A verifier-revision plan needs a bounded producer-verifier cycle; permit at least one',
      },
      {
        path: 'stageVerifiers',
        message: 'A verifier-revision plan needs a stage verifier bound at handoff creation',
      },
    ]);
  });

  test('rejects an edge from a participant to itself', () => {
    const plan = edit(partitionedSearchPlanInput(), (draft) => {
      draft['topology'].edges.push({ from: 'reducer', to: 'reducer', reason: 'Talks to itself.' });
    });
    expect(issuesOf(plan)).toEqual([
      { path: 'topology.edges.3', message: 'An edge joins two different participants' },
    ]);
  });

  test('keeps a direct-agent plan to one participant and no edges', () => {
    const plan = edit(directPlanInput('direct'), (draft) => {
      draft['participants'].push({ ...draft['participants'][0], agentName: 'helper' });
      draft['topology'].edges.push({ from: 'solver', to: 'helper', reason: 'Delegates.' });
    });
    expect(issuesOf(plan)).toEqual([
      { path: 'participants', message: 'A direct-agent plan has exactly one participant' },
      { path: 'topology.edges', message: 'A direct-agent plan has no edges' },
    ]);
  });

  test('requires a shared-state collaboration to declare its authoritative state', () => {
    const plan = edit(sharedStatePlanInput(), (draft) => {
      draft['artifacts'] = [];
    });
    expect(issuesOf(plan)).toEqual([
      {
        path: 'artifacts',
        message: 'A shared-state collaboration declares its authoritative state as an artifact',
      },
    ]);
  });

  test('reuses operative’s DelegatedAuthority for tool authority', () => {
    const plan = edit(partitionedSearchPlanInput(), (draft) => {
      draft['resourceEnvelope'].toolAuthority.grantedProviders = ['acme'];
      draft['resourceEnvelope'].toolAuthority.maximumEffort = 'ludicrous';
      delete draft['resourceEnvelope'].toolAuthority.policyVersion;
    });
    expect(paths(plan).toSorted()).toEqual([
      'resourceEnvelope.toolAuthority.grantedProviders.0',
      'resourceEnvelope.toolAuthority.maximumEffort',
      'resourceEnvelope.toolAuthority.policyVersion',
    ]);
  });

  test('parseCollaborationPlan throws a typed configuration error naming each issue', () => {
    const plan = edit(partitionedSearchPlanInput(), (draft) => {
      draft['planRevision'] = 0;
    });
    expect(() => parseCollaborationPlan(plan)).toThrow(EvaluatorConfigurationError);
    expect(() => parseCollaborationPlan(plan)).toThrow(/planRevision/);
  });

  test('its digest ignores key order and moves with any field', async () => {
    const plan = parseCollaborationPlan(partitionedSearchPlanInput());
    const reordered = Object.fromEntries(Object.entries(plan).toReversed());
    const digest = await collaborationPlanDigest(plan);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await collaborationPlanDigest(parseCollaborationPlan(reordered))).toBe(digest);
    const revised = parseCollaborationPlan({ ...plan, planRevision: 2 });
    expect(await collaborationPlanDigest(revised)).not.toBe(digest);
  });
});

describe('the CollaborationMessage envelope', () => {
  test('binds sender, recipient, relationship, source, trust class, schema, subject, provenance, and correlation', () => {
    expect(collaborationMessageSchema.safeParse(message()).success).toBe(true);
    const parsed = collaborationMessageSchema.safeParse({ intent: 'observation' });
    expect(parsed.success).toBe(false);
  });

  test('requires an evidence digest on a verification result or a commit, and only there', () => {
    for (const intent of ['verification-result', 'commit'] as const) {
      const missing = collaborationMessageSchema.safeParse(message({ intent }));
      expect(missing.success).toBe(false);
      expect(missing.error?.issues.map((issue) => issue.message)).toEqual([
        `A ${intent} message carries the evidence digest it rests on`,
      ]);
      expect(
        collaborationMessageSchema.safeParse(message({ intent, evidenceDigest: 'sha256:abc' }))
          .success,
      ).toBe(true);
    }
    expect(
      collaborationMessageSchema.safeParse(message({ evidenceDigest: 'sha256:abc' })).success,
    ).toBe(true);
  });
});
