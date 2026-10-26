/**
 * `bureau.models.replace(rows)` validates the agent files against the new rows by itself: a file
 * whose model the new catalog no longer holds becomes `invalid` with `unknown-model`, and one
 * whose model the new catalog brings back becomes ready again, without the host asking for a
 * rescan. The directory's once-a-second poll is switched off here, so only `replace` can start one.
 */
import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/operative';
import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';

const harnesses: FileBureauHarness[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
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

/** Runtime services whose once-a-second rescan never fires, so only `replace` can start one. */
function runtimeWithoutPolling(): RuntimeServices {
  const runtime = createDefaultRuntimeServices();
  const timers: RuntimeServices['timers'] = {
    ...runtime.timers,
    setInterval: (_callback, milliseconds) =>
      runtime.timers.setInterval(() => undefined, milliseconds),
  };
  return { ...runtime, timers };
}

it('rescans the agent files against the replaced rows', async () => {
  // The file exists before the Bureau does, so nothing touches the directory afterwards and no
  // file event can start a rescan: only `replace` can.
  const directory = await mkdtemp(join(tmpdir(), 'bureau-models-replace-'));
  directories.push(directory);
  await writeFile(join(directory, 'picker.md'), agentFileText({ model: KNOWN_MODEL }));
  const harness = await startFileBureau({
    directory,
    overrides: { runtime: runtimeWithoutPolling() },
  });
  harnesses.push(harness);
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
