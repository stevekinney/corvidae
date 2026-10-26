/**
 * `bureau.models.replace(rows)` validates the agent files against the new rows by itself: a file
 * whose model the new catalog no longer holds becomes `invalid` with `unknown-model`, and one
 * whose model the new catalog brings back becomes ready again, without the host asking for a
 * rescan. (The directory's once-a-second poll is the backstop; `replace` starts the rescan at once.)
 */
import { afterEach, expect, it } from 'bun:test';

import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const stateOf = (harness: FileBureauHarness) =>
  harness.bureau.agents.list().find((listing) => listing.id === 'picker')?.state;

/** Resolves on the next rescan that reports a change, which `replace` must start. */
function nextChange(harness: FileBureauHarness): Promise<void> {
  return new Promise((resolve) => {
    const stop = harness.bureau.agents.onChange(() => {
      stop();
      resolve();
    });
  });
}

it('rescans the agent files against the replaced rows', async () => {
  const harness = await startFileBureau();
  harnesses.push(harness);
  await harness.put('picker.md', agentFileText({ model: KNOWN_MODEL }));
  await harness.bureau.agents.refresh();
  expect(stateOf(harness)).toBe('ready');

  const all = harness.bureau.models.catalog().descriptors;
  const withoutKnown = all.filter((row) => `${row.provider}/${row.model}` !== KNOWN_MODEL);
  expect(withoutKnown.length).toBe(all.length - 1);

  const dropped = nextChange(harness);
  harness.bureau.models.replace(withoutKnown);
  await dropped;
  expect(stateOf(harness)).toBe('invalid');

  const restored = nextChange(harness);
  harness.bureau.models.replace(all);
  await restored;
  expect(stateOf(harness)).toBe('ready');
});
