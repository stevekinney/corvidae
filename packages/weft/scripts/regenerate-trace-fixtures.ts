/**
 * Regenerates replay and checkpoint-compatibility fixtures for the durable
 * execution engine.
 *
 * Contract: These fixtures freeze observable behavior. Engine PRs must not
 * change any EXISTING record inside a fixture; that is a regression. Adding
 * records under a genuinely new, independent durable key namespace (see the
 * fixture test files' headers for the exact bar this must clear) is the one
 * narrow exception — after running this script for that reason, diff the
 * result against the prior fixture and confirm every change is a new key,
 * not an edit to an existing one.
 */

import type { WorkflowState } from '../src/core/types.ts';
import {
  sortedStorageEntries,
  storageAsBase64Record,
  withDeterministicRuntime,
  type TraceFixture,
} from '../src/testing/trace-fixture-support.test-support.ts';

import {
  assertScenarioInventory,
  scenarios,
  type ScenarioDefinition,
} from './trace-fixture-scenarios.ts';

const replayFixtureDirectory = 'tests/replay-fixtures';
const checkpointFixtureDirectory = 'tests/checkpoint-compat';
const textEncoder = new TextEncoder();

function serializeSnapshot(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const encodedEntries = entries.map(([key, value]) => ({
    keyBytes: textEncoder.encode(key),
    value,
  }));
  const byteLength =
    4 +
    encodedEntries.reduce(
      (total, entry) => total + 4 + entry.keyBytes.byteLength + 4 + entry.value.byteLength,
      0,
    );
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setUint32(offset, encodedEntries.length, true);
  offset += 4;

  for (const entry of encodedEntries) {
    view.setUint32(offset, entry.keyBytes.byteLength, true);
    offset += 4;
    bytes.set(entry.keyBytes, offset);
    offset += entry.keyBytes.byteLength;
    view.setUint32(offset, entry.value.byteLength, true);
    offset += 4;
    bytes.set(entry.value, offset);
    offset += entry.value.byteLength;
  }

  return bytes;
}

async function ensureFixtureDirectories(): Promise<void> {
  await Bun.$`mkdir -p ${replayFixtureDirectory} ${checkpointFixtureDirectory}`.quiet();
}

async function findExistingFixtureFiles(): Promise<string[]> {
  const existingFiles: string[] = [];

  for (const scenario of scenarios) {
    const jsonPath = `${replayFixtureDirectory}/${scenario.name}.json`;
    const binaryPath = `${checkpointFixtureDirectory}/${scenario.name}.bin`;

    if (await Bun.file(jsonPath).exists()) {
      existingFiles.push(jsonPath);
    }

    if (await Bun.file(binaryPath).exists()) {
      existingFiles.push(binaryPath);
    }
  }

  return existingFiles;
}

async function writeScenarioFixture(scenario: ScenarioDefinition): Promise<void> {
  const { engine, workflowId, additionalTerminalWorkflowIds } = await withDeterministicRuntime(
    scenario.run,
  );

  try {
    const finalState = await engine.get(workflowId);
    if (finalState === null) {
      throw new Error(`Workflow "${workflowId}" was not found after scenario "${scenario.name}"`);
    }

    const entries = sortedStorageEntries(engine.storage);
    const fixture: TraceFixture = {
      scenario: scenario.name,
      description: scenario.description,
      events: await engine.getEvents(workflowId),
      timeline: await engine.getTimeline(workflowId),
      finalState,
      storage: storageAsBase64Record(entries),
    };

    if (additionalTerminalWorkflowIds !== undefined) {
      const additionalTerminalStates: WorkflowState[] = [];
      for (const additionalId of additionalTerminalWorkflowIds) {
        const additionalState = await engine.get(additionalId);
        if (additionalState === null) {
          throw new Error(
            `Additional terminal workflow "${additionalId}" was not found after scenario "${scenario.name}"`,
          );
        }
        additionalTerminalStates.push(additionalState);
      }
      fixture.replayMetadata = { version: 1, additionalTerminalStates };
    }

    await Bun.write(
      `${replayFixtureDirectory}/${scenario.name}.json`,
      `${JSON.stringify(fixture, null, 2)}\n`,
    );
    await Bun.write(
      `${checkpointFixtureDirectory}/${scenario.name}.bin`,
      serializeSnapshot(entries),
    );
  } finally {
    engine[Symbol.dispose]();
  }
}

async function main(): Promise<void> {
  const confirmed = Bun.argv.includes('--confirm');

  assertScenarioInventory();

  const existingFixtureFiles = await findExistingFixtureFiles();

  if (!confirmed) {
    const existingMessage =
      existingFixtureFiles.length > 0
        ? ` Existing fixture files would be overwritten:\n${existingFixtureFiles.join('\n')}`
        : '';
    console.error(
      `Refusing to regenerate trace fixtures without --confirm.${existingMessage}\n` +
        'Run: bun run scripts/regenerate-trace-fixtures.ts --confirm',
    );
    process.exit(1);
  }

  await ensureFixtureDirectories();

  for (const scenario of scenarios) {
    await writeScenarioFixture(scenario);
    console.log(`wrote fixtures for ${scenario.name}`);
  }
}

await main();
