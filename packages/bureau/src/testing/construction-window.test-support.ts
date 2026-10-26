/**
 * Fixtures for a Bureau that is parked while it is still being built (COR-1585, COR-1586): a
 * directory holding one valid agent file, so `createBureau`'s construction-time scan reads a file,
 * and a hold on that scan, so the Bureau stays in its construction window for as long as a test
 * needs, with no timing involved.
 *
 * @module construction-window.test-support
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction } from '@lostgradient/operative';
import { spyOn } from 'bun:test';

import { nodeAgentFileOperations } from '../sources/agent-file-operations';
import { agentFileText, KNOWN_MODEL } from './agent-file-fixtures.test-support';

export interface ConstructionWindowFixtures {
  /** A directory holding one valid agent file. Removed by `dispose()`. */
  directoryWithOneAgentFile(): Promise<string>;
  /** A scratch directory. Removed by `dispose()`. */
  scratchDirectory(prefix: string): Promise<string>;
  /**
   * Hold the agent file scan open: the first file read does not return until `release()`. The scan
   * is the `await fileAgents?.files.refresh()` in `createBureau`.
   */
  holdAgentFileScan(): { entered: Promise<void>; release: () => void };
  /** Run `restore` when `dispose()` is called: for a spy a test installs itself. */
  restoreOnDispose(restore: () => void): void;
  /** Release every hold's spy and remove every directory. Call it from `afterEach`. */
  dispose(): Promise<void>;
}

export function createConstructionWindowFixtures(): ConstructionWindowFixtures {
  const directories: string[] = [];
  const restores: Array<() => void> = [];
  return {
    async directoryWithOneAgentFile() {
      const directory = await mkdtemp(join(tmpdir(), 'bureau-construction-window-'));
      directories.push(directory);
      await writeFile(
        join(directory, 'helper.md'),
        agentFileText({ name: 'Helper', model: KNOWN_MODEL }),
      );
      return directory;
    },
    async scratchDirectory(prefix) {
      const directory = await mkdtemp(join(tmpdir(), prefix));
      directories.push(directory);
      return directory;
    },
    holdAgentFileScan() {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const read = nodeAgentFileOperations.read.bind(nodeAgentFileOperations);
      const spy = spyOn(nodeAgentFileOperations, 'read').mockImplementation(async (path) => {
        entered.resolve();
        await released.promise;
        return read(path);
      });
      restores.push(() => spy.mockRestore());
      return { entered: entered.promise, release: () => released.resolve() };
    },
    restoreOnDispose(restore) {
      restores.push(restore);
    },
    async dispose() {
      for (const restore of restores.splice(0)) restore();
      for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

/** An `options.models.generate` for an agent directory: every file agent answers `answer`. */
export const constructionWindowGenerate = (): GenerateFunction => async () => ({
  content: 'answer',
  toolCalls: [],
});
