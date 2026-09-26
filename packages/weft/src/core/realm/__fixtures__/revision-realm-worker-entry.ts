/// <reference lib="webworker" />
/**
 * Real Worker bootstrap fixture for revision-realm tests (COR-249).
 *
 * Imports the workflow-implementation fixture the same way a production
 * revision realm's bootstrap would import real workflow code — this is the
 * "realm side" half of the module-graph boundary test
 * (`revision-realm-module-boundary.test.ts`), which asserts a bundle of THIS
 * file contains `WORKFLOW_IMPLEMENTATION_SENTINEL` while a bundle of the
 * host-side pool/registry modules does not.
 *
 * Reads `self.name` (set via `WorkerOptions.name`, {@link
 * import('../worker-realm.ts').WorkerRealmOptions.workerName}) as the
 * artifact digest this instance advertises, so one physical script can
 * stand in for several distinct revisions in tests — a real deployment
 * instead gives each revision its own built bootstrap module and derives
 * its digest from that build, as `WorkerRealmOptions.workerName`'s own doc
 * notes.
 *
 * Turns do not auto-complete: `realm-run` records the pending turn and
 * waits for an explicit `test-release`/`test-fail` control message, so
 * tests can prove two turns are genuinely concurrent (both in flight, one
 * released before the other) rather than merely fast.
 */

import { buildInternalRealmManifest } from '../../../worker/manifest/internal-realm.ts';
import type {
  RealmFailureMessage,
  RealmResultMessage,
  RealmRunMessage,
} from '../worker-realm-messages.ts';
import { runFixtureWorkflow } from './workflow-implementation.fixture.ts';

const EXPECTED_WORKFLOW_TYPES = ['order-workflow'];
const DEFAULT_ARTIFACT_DIGEST = 'fixture-default-digest';

const realmGeneration = crypto.randomUUID();
const pendingRuns = new Map<number, RealmRunMessage>();

interface TestReleaseMessage {
  readonly type: 'test-release';
  readonly turnId: number;
}

interface TestFailMessage {
  readonly type: 'test-fail';
  readonly turnId: number;
  readonly error: string;
}

function currentArtifactDigest(): string {
  const name = (self as unknown as { name?: string }).name;
  return typeof name === 'string' && name.length > 0 ? name : DEFAULT_ARTIFACT_DIGEST;
}

function sendReady(): void {
  const manifest = buildInternalRealmManifest(EXPECTED_WORKFLOW_TYPES);
  const digest = currentArtifactDigest();
  self.postMessage({
    type: 'ready',
    protocolVersion: manifest.protocolVersion,
    realmGeneration,
    manifest: {
      ...manifest,
      deployment: { ...manifest.deployment, buildId: digest, artifactDigest: digest },
    },
  });
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data as RealmRunMessage | TestReleaseMessage | TestFailMessage;

  if (message.type === 'realm-run') {
    pendingRuns.set(message.envelope.turnId, message);
    return;
  }

  if (message.type === 'test-release') {
    const run = pendingRuns.get(message.turnId);
    if (!run) return;
    pendingRuns.delete(message.turnId);
    const result: RealmResultMessage = {
      type: 'realm-result',
      envelope: run.envelope,
      result: runFixtureWorkflow(run.input),
    };
    self.postMessage(result);
    return;
  }

  if (message.type === 'test-fail') {
    const run = pendingRuns.get(message.turnId);
    if (!run) return;
    pendingRuns.delete(message.turnId);
    const failure: RealmFailureMessage = {
      type: 'realm-failure',
      envelope: run.envelope,
      error: message.error,
    };
    self.postMessage(failure);
  }
};

sendReady();
