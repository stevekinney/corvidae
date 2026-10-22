import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  type RecallRecording,
  recordedBaseline,
  replayRecording,
} from '../../scripts/replay-recall';
import {
  compareMemoryEvidenceManifests,
  type MemoryEvidenceManifest,
} from '../../src/governance/recall-replay';
import { createMemoryRetrievalPlan } from '../../src/governance/retrieval-plan';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'recall');

async function recording(name: string): Promise<RecallRecording> {
  return (await Bun.file(join(FIXTURES, `${name}.json`)).json()) as RecallRecording;
}

const manifest: MemoryEvidenceManifest = {
  revision: 'sha256:bundle',
  planRevision: 'sha256:plan',
  policyRevision: 'governance:1',
  queryDigest: 'sha256:query',
  stopReason: 'sufficient',
  evidence: [
    { recordId: 'a', revision: '1:a', kind: 'source-evidence' },
    { recordId: 'b', revision: '1:b', kind: 'derived-summary' },
  ],
  exclusions: [{ recordId: 'c', revision: '1:c', reason: 'trust-below-minimum' }],
};

/**
 * COR-771 — the replay script re-runs each recorded plan against fixed evidence
 * and policy revisions, and asserts the same ordered evidence manifest or the
 * named deterministic differences the recording expects.
 */
describe('recorded recall replays', () => {
  for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith('.json'))) {
    it(`replays ${file} to its recorded manifest or its named differences`, async () => {
      const replay = await replayRecording(await recording(file.replace(/\.json$/, '')));
      expect(replay.passed).toBe(true);
    });
  }

  it('names a changed record as a deterministic difference, not a silent pass', async () => {
    const recorded = await recording('exact-and-paraphrase');
    const changed: RecallRecording = {
      ...recorded,
      records: recorded.records.map((record, index) =>
        index === 1
          ? { ...record, content: 'The user prefers an aisle seat near the front.' }
          : record,
      ),
    };
    const replay = await replayRecording(changed);
    expect(replay.passed).toBe(false);
    expect(replay.differences.map((difference) => difference.kind)).toContain('record-revision');
  });

  it('names a changed record that stays excluded for the same reason', async () => {
    const recorded = await recording('exact-and-paraphrase');
    const changed: RecallRecording = {
      ...recorded,
      records: recorded.records.map((record, index) =>
        index === 2
          ? { ...record, content: 'Deployment procedure: run every check first.' }
          : record,
      ),
    };
    const replay = await replayRecording(changed);
    expect(replay.passed).toBe(false);
    expect(replay.differences.map((difference) => difference.kind)).toEqual(['record-revision']);
  });

  it('drops expected differences when a recording is refreshed as a new baseline', async () => {
    const recorded = await recording('policy-revision-changed');
    const fresh = await replayRecording(recorded);
    const refreshed = recordedBaseline(recorded, fresh.manifest);
    expect(refreshed).not.toHaveProperty('expectedDifferences');
    const replayed = await replayRecording(refreshed);
    expect(replayed.passed).toBe(true);
  });

  it('fails drift beside an expected difference, because the recording pins its revision', async () => {
    const recorded = await recording('policy-revision-changed');
    const drifted: RecallRecording = {
      ...recorded,
      records: recorded.records.map((record, index) =>
        index === 1
          ? { ...record, content: 'The user prefers an aisle seat near the front.' }
          : record,
      ),
    };
    const replay = await replayRecording(drifted);
    expect(replay.passed).toBe(false);
    const unpinned = await replayRecording({ ...recorded, expectedRevision: undefined });
    expect(unpinned.passed).toBe(false);
  });

  it('never passes a recording that has no baseline to compare against', async () => {
    const { manifest: _baseline, ...recorded } = await recording('exact-and-paraphrase');
    const replay = await replayRecording(recorded);
    expect(replay.differences).toEqual([]);
    expect(replay.passed).toBe(false);
  });

  it('reproduces the bundle revision when nothing changed', async () => {
    const recorded = await recording('exact-and-paraphrase');
    const replay = await replayRecording(recorded);
    expect(replay.manifest.revision).toBe((recorded.manifest as MemoryEvidenceManifest).revision);
    expect(replay.differences).toEqual([]);
  });
});

describe('compareMemoryEvidenceManifests', () => {
  it('reports nothing for an identical manifest', () => {
    expect(compareMemoryEvidenceManifests(manifest, manifest)).toEqual([]);
  });

  it('falls back to the bundle revision when nothing else names a difference', () => {
    const kindChanged: MemoryEvidenceManifest = {
      ...manifest,
      revision: 'sha256:other-bundle',
      evidence: manifest.evidence.map((item) =>
        item.recordId === 'a' ? { ...item, kind: 'historical-projection' } : item,
      ),
    };
    expect(compareMemoryEvidenceManifests(manifest, kindChanged)).toEqual([
      { kind: 'bundle-revision', recorded: 'sha256:bundle', replayed: 'sha256:other-bundle' },
    ]);
  });

  it('names each kind of difference in a fixed order', () => {
    const replayed: MemoryEvidenceManifest = {
      ...manifest,
      planRevision: 'sha256:other-plan',
      stopReason: 'exhausted',
      evidence: [
        { recordId: 'b', revision: '2:b', kind: 'derived-summary' },
        { recordId: 'a', revision: '1:a', kind: 'source-evidence' },
        { recordId: 'd', revision: '1:d', kind: 'source-evidence' },
      ],
      exclusions: [{ recordId: 'c', revision: '1:c', reason: 'evicted' }],
    };
    expect(compareMemoryEvidenceManifests(manifest, replayed)).toEqual([
      { kind: 'plan-revision', recorded: 'sha256:plan', replayed: 'sha256:other-plan' },
      { kind: 'stop-reason', recorded: 'sufficient', replayed: 'exhausted' },
      { kind: 'record-revision', recordId: 'b', recorded: '1:b', replayed: '2:b' },
      { kind: 'evidence-added', recordId: 'd' },
      { kind: 'evidence-order', recorded: ['a', 'b'], replayed: ['b', 'a'] },
      { kind: 'exclusion', recordId: 'c', recorded: 'trust-below-minimum', replayed: 'evicted' },
    ]);
  });
});

describe('retrieval plan budgets', () => {
  it('requires the count budgets to be whole numbers', () => {
    expect(() => createMemoryRetrievalPlan({ budgets: { maxIterations: 1.5 } })).toThrow(
      'whole number',
    );
    expect(() => createMemoryRetrievalPlan({ budgets: { maxCandidates: 2.5 } })).toThrow(
      'whole number',
    );
    expect(createMemoryRetrievalPlan({ budgets: { maxTokens: 10.5 } }).budgets.maxTokens).toBe(
      10.5,
    );
  });
});
