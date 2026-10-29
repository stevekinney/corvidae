/**
 * The development host's source watch (`source-watcher.ts`): the directories a rebuild depends on
 * come from the files the last build read, not from a list, so a workspace the bundle imports is
 * watched and one it does not import is not.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { createRebuildScheduler } from './rebuild-scheduler.ts';
import {
  createSourceWatcher,
  readBuildInputs,
  watchTargets,
  type WatchDirectory,
} from './source-watcher.ts';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-source-watcher-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const repository = '/repository';
const isPackageRoot = (directory: string): boolean =>
  /^\/repository\/(?:applications|components|packages)\/[^/]+$/.test(directory);

describe('watchTargets', () => {
  it('watches each workspace the build read from, Chat included, once', () => {
    const targets = watchTargets(
      [
        `${repository}/applications/interborough/src/main.ts`,
        `${repository}/applications/interborough/src/app/app.svelte`,
        `${repository}/components/cinder/src/index.ts`,
        `${repository}/components/cinder/src/_internal/portal.ts`,
        `${repository}/components/chat/src/index.ts`,
        `${repository}/packages/markdown/src/index.ts`,
      ],
      { isPackageRoot },
    );

    expect(targets).toEqual([
      { directory: `${repository}/applications/interborough/src`, recursive: true },
      { directory: `${repository}/components/chat/src`, recursive: true },
      { directory: `${repository}/components/cinder/src`, recursive: true },
      { directory: `${repository}/packages/markdown/src`, recursive: true },
    ]);
  });

  it('leaves out installed dependencies and the files that are ignored', () => {
    const targets = watchTargets(
      [
        `${repository}/node_modules/.bun/svelte@5/node_modules/svelte/src/index.js`,
        `${repository}/applications/interborough/index.html`,
        `${repository}/applications/interborough/src/main.ts`,
      ],
      { isPackageRoot, ignore: [`${repository}/applications/interborough/index.html`] },
    );

    expect(targets).toEqual([
      { directory: `${repository}/applications/interborough/src`, recursive: true },
    ]);
  });

  it('keeps a directory whose parent holds no input, and drops one a watched parent covers', () => {
    const targets = watchTargets(
      [
        `${repository}/packages/weft/src/client/index.ts`,
        `${repository}/packages/weft/src/core/index.ts`,
        `${repository}/packages/lifecycle/src/index.ts`,
        `${repository}/packages/lifecycle/src/events/emitter.ts`,
      ],
      { isPackageRoot },
    );

    expect(targets.map((target) => target.directory)).toEqual([
      `${repository}/packages/lifecycle/src`,
      `${repository}/packages/weft/src/client`,
      `${repository}/packages/weft/src/core`,
    ]);
  });

  it('watches only the input files that sit directly in a package root', () => {
    const targets = watchTargets(
      [`${repository}/packages/armorer/index.ts`, `${repository}/packages/armorer/src/tool.ts`],
      { isPackageRoot },
    );

    expect(targets).toEqual([
      {
        directory: `${repository}/packages/armorer`,
        recursive: false,
        files: new Set(['index.ts']),
      },
      { directory: `${repository}/packages/armorer/src`, recursive: true },
    ]);
  });
});

describe('readBuildInputs', () => {
  it('reads the recorded paths and reports a missing or malformed record as absent', async () => {
    const recorded = join(scratch, 'recorded.json');
    writeFileSync(recorded, JSON.stringify(['/a/b.ts', 3, '/c.ts']));
    const malformed = join(scratch, 'malformed.json');
    writeFileSync(malformed, '{"not":"a list"');
    const notAList = join(scratch, 'not-a-list.json');
    writeFileSync(notAList, '{}');

    expect(await readBuildInputs(recorded)).toEqual(['/a/b.ts', '/c.ts']);
    expect(await readBuildInputs(join(scratch, 'missing.json'))).toBeUndefined();
    expect(await readBuildInputs(malformed)).toBeUndefined();
    expect(await readBuildInputs(notAList)).toBeUndefined();
  });
});

/** A watch that records what it was asked to watch and lets a test fire a change. */
function recordingWatch() {
  const open = new Map<string, (event: string, filename: string | null) => void>();
  const closed: string[] = [];
  const watch: WatchDirectory = (path, _options, listener) => {
    open.set(path, listener);
    return {
      close: () => {
        open.delete(path);
        closed.push(path);
      },
      on: () => undefined,
    };
  };
  return { watch, open, closed };
}

describe('createSourceWatcher', () => {
  it('watches the application source and says so once while no build has recorded its inputs', async () => {
    const recording = recordingWatch();
    const lines: string[] = [];
    const watcher = createSourceWatcher({
      inputsFile: join(scratch, 'never-written.json'),
      fallbackDirectory: '/application/src',
      onChange: () => {},
      log: (line) => lines.push(line),
      watch: recording.watch,
    });

    await watcher.refresh();
    await watcher.refresh();

    expect(watcher.directories()).toEqual(['/application/src']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/application/src');
    watcher.close();
  });

  it('follows the recorded inputs: a new workspace is watched and one no longer imported is not', async () => {
    const recording = recordingWatch();
    const inputsFile = join(scratch, 'follow.json');
    const watcher = createSourceWatcher({
      inputsFile,
      fallbackDirectory: '/application/src',
      onChange: () => {},
      log: () => {},
      watch: recording.watch,
      isPackageRoot,
    });

    writeFileSync(inputsFile, JSON.stringify([`${repository}/packages/markdown/src/index.ts`]));
    await watcher.refresh();
    expect(watcher.directories()).toEqual([`${repository}/packages/markdown/src`]);

    writeFileSync(
      inputsFile,
      JSON.stringify([
        `${repository}/packages/markdown/src/index.ts`,
        `${repository}/components/chat/src/index.ts`,
      ]),
    );
    await watcher.refresh();
    expect(watcher.directories()).toEqual([
      `${repository}/components/chat/src`,
      `${repository}/packages/markdown/src`,
    ]);

    writeFileSync(inputsFile, JSON.stringify([`${repository}/components/chat/src/index.ts`]));
    await watcher.refresh();
    expect(watcher.directories()).toEqual([`${repository}/components/chat/src`]);
    expect(recording.closed).toEqual([`${repository}/packages/markdown/src`]);

    watcher.close();
    expect(watcher.directories()).toEqual([]);
    await watcher.refresh();
    expect(watcher.directories()).toEqual([]);
  });

  it('reports a change in a watched directory, and in a package root only to a recorded input', async () => {
    const recording = recordingWatch();
    const inputsFile = join(scratch, 'changes.json');
    writeFileSync(
      inputsFile,
      JSON.stringify([
        `${repository}/components/chat/src/index.ts`,
        `${repository}/packages/armorer/index.ts`,
      ]),
    );
    let changes = 0;
    const watcher = createSourceWatcher({
      inputsFile,
      fallbackDirectory: '/application/src',
      onChange: () => (changes += 1),
      log: () => {},
      watch: recording.watch,
      isPackageRoot,
    });
    await watcher.refresh();

    recording.open.get(`${repository}/components/chat/src`)?.('change', 'message.svelte');
    expect(changes).toBe(1);
    recording.open.get(`${repository}/packages/armorer`)?.('change', 'unrelated.json');
    expect(changes).toBe(1);
    recording.open.get(`${repository}/packages/armorer`)?.('change', 'index.ts');
    expect(changes).toBe(2);
    watcher.close();
  });

  it('schedules a rebuild when a file in a recorded directory changes', async () => {
    const workspace = mkdtempSync(join(scratch, 'workspace-'));
    const source = join(workspace, 'src');
    mkdirSync(source);
    const changed = join(source, 'component.ts');
    writeFileSync(changed, 'export const value = 0;\n');
    const inputsFile = join(workspace, 'inputs.json');
    writeFileSync(inputsFile, JSON.stringify([changed]));

    let changes = 0;
    let builds = 0;
    const scheduler = createRebuildScheduler({
      delayMilliseconds: 50,
      build: async () => {
        builds += 1;
      },
    });
    const watcher = createSourceWatcher({
      inputsFile,
      fallbackDirectory: join(workspace, 'elsewhere'),
      onChange: () => {
        changes += 1;
        scheduler.schedule();
      },
      log: () => {},
    });
    await watcher.refresh();
    expect(watcher.directories()).toEqual([source]);

    // A recursive watch has no ready signal, and a save made before the operating system's stream
    // is live is never reported, which a loaded host makes likely. Save again until one is seen.
    // How many builds the saves fold into is the debounce's business (`rebuild-scheduler.test.ts`).
    let revision = 0;
    await waitUntil(
      () => {
        if (changes > 0) return true;
        revision += 1;
        writeFileSync(changed, `export const value = ${revision};\n`);
        return false;
      },
      { message: 'the watch to report a save' },
    );
    await waitUntil(() => builds > 0, { message: 'the scheduled rebuild' });

    watcher.close();
    scheduler.close();
  });
});
