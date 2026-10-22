/**
 * B82 review probe C1 (not part of the PR): a scan that read the file before a peer's edit settles
 * after the peer recorded the edit. Does one edit raise the shared revision by one?
 */
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { type ConditionalTextValueStore, MemoryStorage, textValueStore } from '@lostgradient/weft';
import { afterEach, expect, it } from 'bun:test';

import { AGENT_REVISION_KEY_PREFIX } from './agent-revision-store';
import {
  type AgentFileFixture,
  createAgentFileFixture,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const directory of directories.splice(0)) removeTemporaryPath(directory);
});
const revisionOf = (fixture: AgentFileFixture) =>
  fixture.catalog.list().find((listing) => listing.id === 'helper')?.definitionRevision;

it('one edit seen by two catalogs, one of whose scans read the file just before it', async () => {
  const directory = createTemporaryDirectory('b82-review-stale-scan');
  directories.push(directory);
  const shared = textValueStore(new MemoryStorage());
  // The left catalog's view of the shared store: while `gate` is armed, a revision read waits.
  let gate: { reached: () => void; release: Promise<void> } | undefined;
  const leftStore: ConditionalTextValueStore = {
    ...shared,
    async get(key) {
      if (gate !== undefined && key.startsWith(AGENT_REVISION_KEY_PREFIX)) {
        const held = gate;
        gate = undefined;
        held.reached();
        await held.release;
      }
      return shared.get(key);
    },
  };
  const left = await createAgentFileFixture({ watch: false, directory, revisionStore: leftStore });
  const right = await createAgentFileFixture({ watch: false, directory, revisionStore: shared });
  fixtures.push(left, right);
  const one = validAgentFile('Version one.\n');
  const two = validAgentFile('Version two.\n');

  await left.put('helper.md', one);
  await Promise.all([left.catalog.refresh(), right.catalog.refresh()]);

  let release!: () => void;
  let reached!: () => void;
  const atSettle = new Promise<void>((resolve) => (reached = resolve));
  gate = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
  // left's scan reads "one" and pauses at its revision read.
  const leftScan = left.catalog.refresh();
  const pausedAtSettle = await Promise.race([
    atSettle.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  // The edit, and the right catalog records it.
  await left.put('helper.md', two);
  await right.catalog.refresh();
  const afterRight = JSON.parse((await shared.get(`${AGENT_REVISION_KEY_PREFIX}helper`)) ?? '{}');
  release();
  await leftScan;
  const afterStale = JSON.parse((await shared.get(`${AGENT_REVISION_KEY_PREFIX}helper`)) ?? '{}');
  const leftDuringStale = revisionOf(left);
  // Both catch up with the file.
  await left.catalog.refresh();
  await right.catalog.refresh();
  const final = JSON.parse((await shared.get(`${AGENT_REVISION_KEY_PREFIX}helper`)) ?? '{}');
  console.log(
    `C1 observed: leftPausedAtSettle=${pausedAtSettle} afterRight=${afterRight.revision} afterStaleLeftScan=${afterStale.revision} (hash is one: ${afterStale.hash === left.catalog.list()[0]?.definitionHash ? 'no' : 'see final'}) leftReportedThen=${leftDuringStale} final=${final.revision} left=${revisionOf(left)} right=${revisionOf(right)}`,
  );
  expect(final.revision).toBe(2);
  expect([revisionOf(left), revisionOf(right)]).toEqual([2, 2]);
});
