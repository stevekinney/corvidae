import { describe, expect, it } from 'bun:test';

import { buildInternalRealmManifest } from '../../worker/manifest/internal-realm.ts';
import { FakeRealm, type FakeRealmActivation } from './fake-realm.test-support.ts';
import { RealmEnvelopeMismatchError, type RealmTurnEnvelope } from './realm-protocol.ts';

function fakeRealm(
  overrides: Partial<{
    isReferenced: () => boolean;
    maxRestarts: number;
    expectedWorkflowTypes: readonly string[];
    expectedArtifactDigest: string;
  }> = {},
): FakeRealm {
  return new FakeRealm({
    isReferenced: overrides.isReferenced ?? (() => true),
    maxRestarts: overrides.maxRestarts ?? 3,
    expectedWorkflowTypes: overrides.expectedWorkflowTypes ?? ['order-workflow'],
    ...(overrides.expectedArtifactDigest === undefined
      ? {}
      : { expectedArtifactDigest: overrides.expectedArtifactDigest }),
  });
}

const activation: FakeRealmActivation = {
  workflowRevision: 'revision-a',
  realmGeneration: 'generation-1',
  executionToken: 'token-1',
};

function turn(overrides: Partial<RealmTurnEnvelope> = {}): RealmTurnEnvelope {
  return { ...activation, turnId: 1, ...overrides };
}

async function readyAndActive(realm: FakeRealm, realmGeneration = 'generation-1'): Promise<void> {
  const outcome = await realm.sendReady(realm.buildReadyMessage(realmGeneration));
  expect(outcome.ok).toBe(true);
  realm.activate({ ...activation, realmGeneration });
}

describe('FakeRealm', () => {
  describe('ready-manifest validation gates Ready and turn execution', () => {
    it('cannot execute a turn while Warming, before any ready handshake', async () => {
      const realm = fakeRealm();
      await expect(realm.dispatchTurn(turn())).rejects.toThrow(
        'Fake realm cannot accept a turn while warming',
      );
    });

    it('enters Crashed, not Ready, when the manifest is missing an expected workflow type', async () => {
      const realm = fakeRealm({ expectedWorkflowTypes: ['order-workflow'] });
      const message = {
        type: 'ready',
        protocolVersion: (realm.buildReadyMessage('g1') as { protocolVersion: number })
          .protocolVersion,
        realmGeneration: 'g1',
        manifest: buildInternalRealmManifest(['a-different-workflow']),
      };

      const outcome = await realm.sendReady(message);

      expect(outcome.ok).toBe(false);
      expect(realm.lifecycle.state).toBe('crashed');
    });

    it('enters Crashed, not Ready, when the artifact digest disagrees despite matching per-type contracts', async () => {
      const realm = fakeRealm({
        expectedWorkflowTypes: ['order-workflow'],
        expectedArtifactDigest: 'sha256:expected-digest-that-will-not-match',
      });

      const outcome = await realm.sendReady(realm.buildReadyMessage('g1'));

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toContain('artifact digest');
      expect(realm.lifecycle.state).toBe('crashed');
    });

    it('a realm cannot run user code (dispatchTurn) after failing its ready handshake', async () => {
      const realm = fakeRealm({ expectedWorkflowTypes: ['order-workflow'] });
      await realm.sendReady({
        type: 'ready',
        protocolVersion: 2,
        realmGeneration: 'g1',
        manifest: buildInternalRealmManifest(['wrong-workflow']),
      });
      expect(realm.lifecycle.state).toBe('crashed');

      await expect(realm.dispatchTurn(turn())).rejects.toThrow(
        'Fake realm cannot accept a turn while crashed',
      );
    });

    it('enters Ready, then Active, on a validated manifest and artifact digest', async () => {
      const manifest = buildInternalRealmManifest(['order-workflow']);
      const realm = fakeRealm({
        expectedWorkflowTypes: ['order-workflow'],
        expectedArtifactDigest: manifest.deployment.artifactDigest,
      });

      const outcome = await realm.sendReady(realm.buildReadyMessage('g1'));
      expect(outcome.ok).toBe(true);
      expect(realm.lifecycle.state).toBe('ready');

      realm.activate({ ...activation, realmGeneration: 'g1' });
      expect(realm.lifecycle.state).toBe('active');
    });
  });

  describe('wrong revision, realm generation, execution token, or turn ID is rejected', () => {
    it('rejects a turn with the wrong workflowRevision', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm);
      await expect(
        realm.dispatchTurn(turn({ workflowRevision: 'revision-b' })),
      ).rejects.toBeInstanceOf(RealmEnvelopeMismatchError);
      expect(realm.pendingTurnCount).toBe(0);
    });

    it('rejects a turn with the wrong realmGeneration', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm, 'generation-1');
      await expect(
        realm.dispatchTurn(turn({ realmGeneration: 'generation-stale' })),
      ).rejects.toBeInstanceOf(RealmEnvelopeMismatchError);
      expect(realm.pendingTurnCount).toBe(0);
    });

    it('rejects a turn with the wrong executionToken', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm);
      await expect(
        realm.dispatchTurn(turn({ executionToken: 'wrong-token' })),
      ).rejects.toBeInstanceOf(RealmEnvelopeMismatchError);
      expect(realm.pendingTurnCount).toBe(0);
    });

    it('rejects an out-of-order turnId', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm);
      await expect(realm.dispatchTurn(turn({ turnId: 2 }))).rejects.toBeInstanceOf(
        RealmEnvelopeMismatchError,
      );
      expect(realm.pendingTurnCount).toBe(0);
    });

    it('accepts a correctly sequenced turn and settles it through acceptResult', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm);
      const pending = realm.dispatchTurn(turn({ turnId: 1 }));
      expect(realm.pendingTurnCount).toBe(1);

      const accepted = realm.acceptResult(1, 'the-result');
      expect(accepted).toEqual({ accepted: true, result: 'the-result' });
      await expect(pending).resolves.toBe('the-result');
      expect(realm.pendingTurnCount).toBe(0);
    });

    it('advances the expected turnId only after a turn is accepted for dispatch', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm);
      const first = realm.dispatchTurn(turn({ turnId: 1 }));
      realm.acceptResult(1, 'first');
      await expect(first).resolves.toBe('first');

      const second = realm.dispatchTurn(turn({ turnId: 2 }));
      realm.acceptResult(2, 'second');
      await expect(second).resolves.toBe('second');
    });
  });

  describe('a drained realm terminates and cannot emit an accepted late result', () => {
    it('refuses a new turn dispatch once draining', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm);
      realm.beginDrain();

      await expect(realm.dispatchTurn(turn())).rejects.toThrow(
        'Fake realm cannot accept a turn while draining',
      );
    });

    it('refuses to accept a result once terminated, even for a turn number that was legitimately in flight', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm);
      const pending = realm.dispatchTurn(turn({ turnId: 1 }));
      pending.catch(() => {
        /* expected: the realm crashes/terminates before this settles successfully */
      });

      realm.beginDrain();
      realm.terminate();
      expect(realm.lifecycle.state).toBe('terminated');

      const lateResult = realm.acceptResult(1, 'too-late');
      expect(lateResult).toEqual({ accepted: false, reason: 'realm-not-active' });
    });
  });

  describe('realm crash settles all pending turns and isolates sibling revisions', () => {
    it('settles every pending turn on this realm with a rejection when it crashes', async () => {
      const realm = fakeRealm();
      await readyAndActive(realm);
      const first = realm.dispatchTurn(turn({ turnId: 1 }));
      const second = realm.dispatchTurn(turn({ turnId: 2 }));
      expect(realm.pendingTurnCount).toBe(2);

      realm.crash();

      expect(realm.lifecycle.state).toBe('crashed');
      expect(realm.pendingTurnCount).toBe(0);
      await expect(first).rejects.toThrow();
      await expect(second).rejects.toThrow();
    });

    it('does not touch a sibling realm (a different revision) pending turns when one realm crashes', async () => {
      const crashingRealm = fakeRealm();
      const siblingRealm = fakeRealm();
      await readyAndActive(crashingRealm, 'generation-crashing');
      await readyAndActive(siblingRealm, 'generation-sibling');

      const crashingTurn = crashingRealm.dispatchTurn(
        turn({ realmGeneration: 'generation-crashing' }),
      );
      const siblingTurn = siblingRealm.dispatchTurn(
        turn({ realmGeneration: 'generation-sibling' }),
      );

      crashingRealm.crash();

      expect(crashingRealm.lifecycle.state).toBe('crashed');
      expect(siblingRealm.lifecycle.state).toBe('active');
      expect(siblingRealm.pendingTurnCount).toBe(1);
      await expect(crashingTurn).rejects.toThrow();

      const siblingAccepted = siblingRealm.acceptResult(1, 'sibling-still-fine');
      expect(siblingAccepted).toEqual({ accepted: true, result: 'sibling-still-fine' });
      await expect(siblingTurn).resolves.toBe('sibling-still-fine');
    });
  });

  describe('bounded restart from Crashed, only when referenced', () => {
    it('restarts to Warming when referenced, and a fresh ready handshake can reach Active again', async () => {
      const realm = fakeRealm({ isReferenced: () => true, maxRestarts: 2 });
      await realm.sendReady({
        type: 'ready',
        protocolVersion: 2,
        realmGeneration: 'g1',
        manifest: buildInternalRealmManifest(['wrong-workflow']),
      });
      expect(realm.lifecycle.state).toBe('crashed');

      expect(realm.restart()).toEqual({ ok: true });
      expect(realm.lifecycle.state).toBe('warming');

      const outcome = await realm.sendReady(realm.buildReadyMessage('g2'));
      expect(outcome.ok).toBe(true);
      realm.activate({ ...activation, realmGeneration: 'g2' });
      expect(realm.lifecycle.state).toBe('active');
    });

    it('refuses to restart an unreferenced crashed realm', async () => {
      const realm = fakeRealm({ isReferenced: () => false });
      await realm.sendReady({
        type: 'ready',
        protocolVersion: 2,
        realmGeneration: 'g1',
        manifest: buildInternalRealmManifest(['wrong-workflow']),
      });

      expect(realm.restart()).toEqual({ ok: false, reason: 'unreferenced' });
      expect(realm.lifecycle.state).toBe('crashed');
    });
  });
});
