import type { InputDetector } from 'armorer';
import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_DELETION_BOUND_MILLISECONDS,
  DEFAULT_EPISODIC_RETENTION_MILLISECONDS,
  DEFAULT_SUPERSEDED_RETENTION_MILLISECONDS,
  MINIMUM_AUDIT_RECEIPT_RETENTION_MILLISECONDS,
  MemoryGovernancePolicyError,
  createMemoryGovernancePolicy,
  lowestTrust,
  resolveTenantPolicy,
  trustAtLeast,
} from '../../src/governance/policy';

const DAY = 24 * 60 * 60 * 1000;

const quietDetector: InputDetector = {
  name: 'quiet',
  detect: async () => ({ triggered: false, confidence: 0, category: 'none' }),
};

describe('createMemoryGovernancePolicy defaults (COR-806)', () => {
  const policy = createMemoryGovernancePolicy({ revision: 'governance:1' });

  it('fixes the bounded-async deletion lane at 24 hours', () => {
    expect(DEFAULT_DELETION_BOUND_MILLISECONDS).toBe(DAY);
    expect(policy.deletionBoundMilliseconds).toBe(DAY);
  });

  it('assigns the per-class retention defaults from the binding decision', () => {
    expect(policy.retention.classes).toEqual({
      working: { kind: 'run-lifetime' },
      episodic: { kind: 'duration', milliseconds: 90 * DAY },
      semantic: { kind: 'until-superseded', supersededMilliseconds: 90 * DAY },
      procedural: { kind: 'until-superseded', supersededMilliseconds: 90 * DAY },
      identity: { kind: 'subject-deletable' },
      resource: { kind: 'source-linked' },
    });
    expect(DEFAULT_EPISODIC_RETENTION_MILLISECONDS).toBe(90 * DAY);
    expect(DEFAULT_SUPERSEDED_RETENTION_MILLISECONDS).toBe(90 * DAY);
    expect(policy.retention.auditReceiptMilliseconds).toBe(365 * DAY);
    expect(MINIMUM_AUDIT_RECEIPT_RETENTION_MILLISECONDS).toBe(365 * DAY);
  });

  it('treats every model-reachable source as untrusted', () => {
    expect(policy.admission.sourceTrust).toEqual({
      conversation: 'untrusted',
      'model-tool': 'untrusted',
      'tool-result': 'untrusted',
      'ingested-document': 'untrusted',
      derived: 'untrusted',
      operator: 'verified',
      system: 'system',
    });
    expect(policy.admission.onDetection).toBe('quarantine');
  });

  it('requires verified trust before procedures or identity reach a model', () => {
    expect(policy.recall.minimumTrust.procedural).toBe('verified');
    expect(policy.recall.minimumTrust.identity).toBe('verified');
    expect(policy.recall.minimumTrust.episodic).toBe('untrusted');
  });

  it('installs a poisoning detector on both admission and recall', () => {
    expect(policy.admission.detectors.map((detector) => detector.name)).toEqual([
      'memory-poisoning',
    ]);
    expect(policy.recall.detectors.map((detector) => detector.name)).toEqual(['memory-poisoning']);
  });
});

describe('createMemoryGovernancePolicy overrides', () => {
  it('merges admission, recall, retention, and tenant overrides', () => {
    const policy = createMemoryGovernancePolicy({
      revision: 'governance:2',
      admission: { detectors: [quietDetector], onDetection: 'reject', maxContentLength: 10 },
      recall: { detectors: [quietDetector], minimumTrust: { episodic: 'verified' } },
      retention: { episodic: { kind: 'duration', milliseconds: 30 * DAY } },
      auditReceiptMilliseconds: 400 * DAY,
      deletionBoundMilliseconds: 2 * DAY,
      tenants: { 'tenant-b': { deletionBoundMilliseconds: 6 * 60 * 60 * 1000 } },
    });
    expect(policy.admission.onDetection).toBe('reject');
    expect(policy.admission.maxContentLength).toBe(10);
    expect(policy.admission.maxRecordsPerCollection).toBe(10_000);
    expect(policy.recall.minimumTrust.episodic).toBe('verified');
    expect(policy.recall.minimumTrust.procedural).toBe('verified');
    expect(policy.retention.classes.episodic).toEqual({ kind: 'duration', milliseconds: 30 * DAY });
    expect(policy.retention.auditReceiptMilliseconds).toBe(400 * DAY);
    expect(policy.deletionBoundMilliseconds).toBe(2 * DAY);
  });
});

describe('contributed detectors (COR-1875)', () => {
  const contributed: InputDetector = {
    name: 'contributed',
    detect: async () => ({ triggered: false, confidence: 0, category: 'none' }),
  };

  it('runs a contributed detector after the poisoning detector on admission and on recall', () => {
    const policy = createMemoryGovernancePolicy({
      revision: 'governance:contributed',
      admission: { contributedDetectors: [contributed] },
      recall: { contributedDetectors: [contributed] },
    });
    expect(policy.admission.detectors.map((detector) => detector.name)).toEqual([
      'memory-poisoning',
      'contributed',
    ]);
    expect(policy.recall.detectors.map((detector) => detector.name)).toEqual([
      'memory-poisoning',
      'contributed',
    ]);
  });

  it('runs a contributed detector after the detectors a host chose in place of the default', () => {
    const policy = createMemoryGovernancePolicy({
      revision: 'governance:contributed',
      admission: { detectors: [quietDetector], contributedDetectors: [contributed] },
    });
    expect(policy.admission.detectors.map((detector) => detector.name)).toEqual([
      'quiet',
      'contributed',
    ]);
  });

  it('adds nothing when no detector is contributed', () => {
    const policy = createMemoryGovernancePolicy({
      revision: 'governance:contributed',
      admission: { contributedDetectors: [] },
    });
    expect(policy.admission.detectors.map((detector) => detector.name)).toEqual([
      'memory-poisoning',
    ]);
  });
});

describe('resolveTenantPolicy', () => {
  const policy = createMemoryGovernancePolicy({
    revision: 'governance:3',
    tenants: {
      'tenant-b': {
        deletionBoundMilliseconds: 60_000,
        retention: { episodic: { kind: 'duration', milliseconds: 7 * DAY } },
        auditReceiptMilliseconds: 730 * DAY,
      },
    },
  });

  it('returns the deployment defaults for a tenant without an override', () => {
    expect(resolveTenantPolicy(policy, 'tenant-a')).toEqual({
      deletionBoundMilliseconds: DAY,
      retention: policy.retention.classes,
      auditReceiptMilliseconds: 365 * DAY,
    });
  });

  it('applies a per-tenant bound, retention, and audit override', () => {
    const resolved = resolveTenantPolicy(policy, 'tenant-b');
    expect(resolved.deletionBoundMilliseconds).toBe(60_000);
    expect(resolved.retention.episodic).toEqual({ kind: 'duration', milliseconds: 7 * DAY });
    expect(resolved.retention.semantic).toEqual(policy.retention.classes.semantic);
    expect(resolved.auditReceiptMilliseconds).toBe(730 * DAY);
  });
});

describe('policy validation fails closed', () => {
  it.each([
    ['an empty revision', { revision: '' }],
    ['no admission detectors', { revision: 'r', admission: { detectors: [] } }],
    ['no recall detectors', { revision: 'r', recall: { detectors: [] } }],
    ['a non-positive content limit', { revision: 'r', admission: { maxContentLength: 0 } }],
    ['a non-positive quota', { revision: 'r', admission: { maxRecordsPerCollection: -1 } }],
    ['a zero deletion bound', { revision: 'r', deletionBoundMilliseconds: 0 }],
    ['audit retention under one year', { revision: 'r', auditReceiptMilliseconds: 30 * DAY }],
    [
      'a zero retention duration',
      { revision: 'r', retention: { episodic: { kind: 'duration', milliseconds: 0 } } },
    ],
    [
      'a zero superseded retention',
      {
        revision: 'r',
        retention: { semantic: { kind: 'until-superseded', supersededMilliseconds: 0 } },
      },
    ],
    ['a zero tenant bound', { revision: 'r', tenants: { t: { deletionBoundMilliseconds: 0 } } }],
    [
      'a tenant audit retention under one year',
      { revision: 'r', tenants: { t: { auditReceiptMilliseconds: DAY } } },
    ],
    [
      'a tenant zero retention duration',
      {
        revision: 'r',
        tenants: { t: { retention: { episodic: { kind: 'duration', milliseconds: -5 } } } },
      },
    ],
  ] as const)('rejects %s', (_label, input) => {
    expect(() =>
      createMemoryGovernancePolicy(input as Parameters<typeof createMemoryGovernancePolicy>[0]),
    ).toThrow(MemoryGovernancePolicyError);
  });
});

describe('trust ordering', () => {
  it('orders untrusted below verified below system', () => {
    expect(trustAtLeast('verified', 'untrusted')).toBe(true);
    expect(trustAtLeast('untrusted', 'verified')).toBe(false);
    expect(trustAtLeast('system', 'system')).toBe(true);
  });

  it('taints a combination down to its least trusted input', () => {
    expect(lowestTrust(['system', 'verified'])).toBe('verified');
    expect(lowestTrust(['verified', 'untrusted', 'system'])).toBe('untrusted');
    expect(lowestTrust([])).toBe('system');
  });
});
