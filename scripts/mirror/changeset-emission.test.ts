import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { rejectionOf } from '../promise-outcome.test-support.ts';
import {
  assertImmutable,
  ChangesetEmissionError,
  planChangesetEmission,
} from './changeset-emission.ts';
import { ChangesetError } from './changesets.ts';
import { findForeignCommits, git, provenanceTrailer } from './sync.ts';
import { loadTargetOwnedPolicy } from './target-owned.ts';

const cleanup: string[] = [];

afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

function changeset(name: string, text = 'Fix the thing.'): string {
  return `---\n"${name}": patch\n---\n\n${text}\n`;
}

const weftChangeset = changeset('@lostgradient/weft');

async function repository(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `changeset-${label}-`));
  cleanup.push(directory);
  await git(directory, 'init', '--quiet', '--initial-branch=main');
  await git(directory, 'config', 'user.email', 'fixture@example.test');
  await git(directory, 'config', 'user.name', 'Fixture');
  return directory;
}

async function write(directory: string, path: string, contents: string): Promise<void> {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await Bun.write(join(directory, path), contents);
}

async function commit(directory: string, message: string): Promise<string> {
  await git(directory, 'add', '--all');
  await git(directory, 'commit', '--quiet', '--allow-empty', '--message', message);
  const head = await git(directory, 'rev-parse', 'HEAD');
  return head.trim();
}

/** A corvidae history whose first commit carries only the README, as the real directory does. */
async function corvidae(): Promise<{ root: string; start: string }> {
  const root = await repository('corvidae');
  await write(root, '.changeset/README.md', '# Release intent\n');
  return { root, start: await commit(root, 'Start') };
}

/** A target clone that carries the Changesets configuration and one mirror commit. */
async function target(trailer: string): Promise<string> {
  const directory = await repository('target');
  await write(directory, '.changeset/config.json', '{}\n');
  await commit(directory, 'Target before any sync');
  await write(directory, 'packages/weft/src/index.ts', 'export {};\n');
  await commit(directory, `Sync weft from corvidae\n\n${provenanceTrailer}: ${trailer}`);
  return directory;
}

async function emit(
  root: string,
  clone: string,
  trailerSha: string | null,
  mirror: 'weft' | 'cinder' | 'agent-bureau' = 'weft',
  log: (line: string) => void = () => {},
) {
  return planChangesetEmission({
    corvidaeRoot: root,
    target: mirror,
    targetDirectory: clone,
    trailerSha,
    log,
  });
}

function emittedPath(adding: string, name: string): string {
  return `.changeset/corvidae-${adding.slice(0, 12)}-${name}.md`;
}

const text = (contents: string | Uint8Array | undefined): string =>
  typeof contents === 'string' ? contents : new TextDecoder().decode(contents);

describe('changeset emission', () => {
  test('(a) emits a fresh changeset to its own target only, under the adding commit', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const adding = await commit(root, 'Add a changeset');
    const clone = await target(start);

    const files = await emit(root, clone, start);
    expect(Object.keys(files)).toEqual([emittedPath(adding, 'fix-a')]);
    expect(text(files[emittedPath(adding, 'fix-a')])).toBe(weftChangeset);
    expect(await emit(root, clone, start, 'cinder')).toEqual({});
    expect(await emit(root, clone, start, 'agent-bureau')).toEqual({});
  });

  test('(a) writes the bytes of the corvidae file, including CRLF line endings', async () => {
    const { root, start } = await corvidae();
    const crlf = weftChangeset.replaceAll('\n', '\r\n');
    await write(root, '.changeset/crlf.md', crlf);
    const adding = await commit(root, 'Add a CRLF changeset');
    const files = await emit(root, await target(start), start);
    expect(text(files[emittedPath(adding, 'crlf')])).toBe(crlf);
  });

  test('(b) does not emit a file already present at the trailer SHA', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    expect(await emit(root, await target(synced), synced)).toEqual({});
  });

  test('(d) does not emit a file added and deleted inside the range', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    await commit(root, 'Add a changeset');
    await git(root, 'rm', '--quiet', '.changeset/fix-a.md');
    await commit(root, 'Delete the changeset');
    expect(await emit(root, await target(start), start)).toEqual({});
  });

  test('deleting a synced changeset in a commit that adds nothing is allowed', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/old-name.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'rm', '--quiet', '.changeset/old-name.md');
    await commit(root, 'Consume the changeset');
    await write(root, '.changeset/later.md', weftChangeset);
    const later = await commit(root, 'A later changeset');
    expect(Object.keys(await emit(root, await target(synced), synced))).toEqual([
      emittedPath(later, 'later'),
    ]);
  });

  test('(f) the same trailer gives identical output on a repeat run', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    await write(root, '.changeset/fix-b.md', changeset('@lostgradient/weft', 'Another.'));
    await commit(root, 'Add changesets');
    const clone = await target(start);
    expect(await emit(root, clone, start)).toEqual(await emit(root, clone, start));
  });

  test('(g) does not re-emit a path the base branch added and then consumed', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const adding = await commit(root, 'Add a changeset');
    const clone = await target(start);
    const path = emittedPath(adding, 'fix-a');
    await write(clone, path, weftChangeset);
    await commit(clone, 'Sync weft from corvidae (emitted)');
    await git(clone, 'rm', '--quiet', path);
    await commit(clone, 'Version Packages');

    const logged: string[] = [];
    expect(await emit(root, clone, start, 'weft', (line) => logged.push(line))).toEqual({});
    expect(logged.join('\n')).toContain(path);
  });

  test('(g) a copy that exists only on another target branch does not cause a skip', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const adding = await commit(root, 'Add a changeset');
    const clone = await target(start);
    const path = emittedPath(adding, 'fix-a');
    await git(clone, 'checkout', '--quiet', '-b', 'mirror-sync-closed');
    await write(clone, path, weftChangeset);
    await commit(clone, 'A closed sync branch');
    await git(clone, 'checkout', '--quiet', 'main');
    expect(Object.keys(await emit(root, clone, start))).toEqual([path]);
  });

  test('(g2) two pending files with identical text are both emitted', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/one.md', weftChangeset);
    await write(root, '.changeset/two.md', weftChangeset);
    const adding = await commit(root, 'Add two identical changesets');
    const files = await emit(root, await target(start), start);
    expect(Object.keys(files).toSorted()).toEqual([
      emittedPath(adding, 'one'),
      emittedPath(adding, 'two'),
    ]);
  });

  test('(g) a merge that brought in a side branch adding and deleting the path still skips it', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const adding = await commit(root, 'Add a changeset');
    const clone = await target(start);
    const path = emittedPath(adding, 'fix-a');
    await git(clone, 'checkout', '--quiet', '-b', 'side');
    await write(clone, path, weftChangeset);
    await commit(clone, 'Side: deliver');
    await git(clone, 'rm', '--quiet', path);
    await commit(clone, 'Side: consume');
    await git(clone, 'checkout', '--quiet', 'main');
    await write(clone, 'unrelated.txt', 'main moved\n');
    await commit(clone, 'Main moves');
    await git(clone, 'merge', '--quiet', '--no-ff', '--message', 'Merge side', 'side');
    expect(await emit(root, clone, start)).toEqual({});
  });

  test('(h) a target-authored changeset is neither flagged foreign nor reached by the plan', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const adding = await commit(root, 'Add a changeset');
    const clone = await target(start);
    await write(clone, '.changeset/mcp-x.md', changeset('@lostgradient/cinder-mcp'));
    await commit(clone, 'Author a target-only changeset');

    const files = await emit(root, clone, start);
    expect(Object.keys(files)).toEqual([emittedPath(adding, 'fix-a')]);
    const ownership = {
      policy: await loadTargetOwnedPolicy(),
      target: 'weft',
      transform: { files: new Set(Object.keys(files)), prefixes: [] },
    };
    expect(await findForeignCommits(clone, ownership)).toEqual([]);
  });

  test('(i) the target deleting a consumed changeset is not a foreign commit', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const adding = await commit(root, 'Add a changeset');
    const clone = await target(start);
    const path = emittedPath(adding, 'fix-a');
    await write(clone, path, weftChangeset);
    await commit(clone, `Sync weft from corvidae\n\n${provenanceTrailer}: ${adding}`);
    await git(clone, 'rm', '--quiet', path);
    await commit(clone, 'Version Packages');

    // Whether the next sync's trailer has caught up (nothing pending) or was reset to before the
    // addition (the base history skips the path), the plan no longer reaches the path.
    for (const trailer of [adding, start]) {
      const files = await emit(root, clone, trailer);
      expect(files).toEqual({});
      const ownership = {
        policy: await loadTargetOwnedPolicy(),
        target: 'weft',
        transform: { files: new Set(Object.keys(files)), prefixes: [] },
      };
      expect(await findForeignCommits(clone, ownership)).toEqual([]);
    }
  });

  test('(j) a target without a changesets configuration throws', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    await commit(root, 'Add a changeset');
    const clone = await target(start);
    await git(clone, 'rm', '--quiet', '.changeset/config.json');
    await commit(clone, 'Remove the configuration');
    const error = await rejectionOf(emit(root, clone, start));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain('config.json');
  });

  test('(k) a trailer SHA absent from corvidae throws', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    await commit(root, 'Add a changeset');
    const missing = 'f'.repeat(40);
    const error = await rejectionOf(emit(root, await target(missing), missing));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain(missing);
  });

  test('(k) a trailer SHA that is not an ancestor of HEAD throws', async () => {
    const { root, start } = await corvidae();
    await git(root, 'checkout', '--quiet', '-b', 'side');
    await write(root, 'side.txt', 'side\n');
    const side = await commit(root, 'Side commit');
    await git(root, 'checkout', '--quiet', 'main');
    await write(root, '.changeset/fix-a.md', weftChangeset);
    await commit(root, 'Add a changeset');
    const error = await rejectionOf(emit(root, await target(start), side));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
  });

  test('a target with no provenance gets nothing on its first sync', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    await commit(root, 'Add a changeset');
    expect(await emit(root, await target('unused'), null)).toEqual({});
  });

  test('an invalid pending changeset throws instead of being skipped', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/bad.md', '---\n"@lostgradient/weft": none\n---\n\nText.\n');
    await commit(root, 'Add a bad changeset');
    const error = await rejectionOf(emit(root, await target(start), start));
    expect(error).toBeInstanceOf(ChangesetError);
    expect((error as Error).message).toContain('.changeset/bad.md');
  });

  test('(l) with no pending changesets no target receives a .changeset path', async () => {
    const { root, start } = await corvidae();
    await write(root, 'README.md', 'unrelated\n');
    await commit(root, 'Unrelated change');
    for (const mirror of ['weft', 'cinder', 'agent-bureau'] as const) {
      expect(await emit(root, await target(start), start, mirror)).toEqual({});
    }
  });

  test('(l) a checkout with no changesets needs neither git history nor a resolvable trailer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'changeset-plain-'));
    cleanup.push(root);
    await write(root, '.changeset/README.md', '# Release intent\n');
    const clone = await target('unused');
    expect(await emit(root, clone, 'corvidae-label')).toEqual({});
  });

  test('(c) an edit after the add throws for every target', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    await write(root, '.changeset/fix-a.md', changeset('@lostgradient/weft', 'A better sentence.'));
    await commit(root, 'Edit the changeset');
    for (const mirror of ['weft', 'cinder', 'agent-bureau'] as const) {
      const error = await rejectionOf(emit(root, await target(synced), synced, mirror));
      expect(error).toBeInstanceOf(ChangesetEmissionError);
      expect((error as Error).message).toContain('.changeset/fix-a.md');
      expect((error as Error).message).toContain(
        'to replace a changeset, delete it in one pull request and add the replacement in a separate, later pull request',
      );
    }
  });

  test('a retarget is an edit and throws', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/note.md', weftChangeset);
    const synced = await commit(root, 'Add a weft changeset');
    await write(root, '.changeset/note.md', changeset('@lostgradient/cinder', 'Now for cinder.'));
    await commit(root, 'Retarget the changeset');
    for (const mirror of ['weft', 'cinder'] as const) {
      expect(await rejectionOf(emit(root, await target(synced), synced, mirror))).toBeInstanceOf(
        ChangesetEmissionError,
      );
    }
  });

  test('(e) a rename git detects throws, whether or not the file had synced', async () => {
    for (const synchronized of [true, false]) {
      const { root, start } = await corvidae();
      await write(root, '.changeset/old-name.md', weftChangeset);
      const added = await commit(root, 'Add a changeset');
      await git(root, 'mv', '.changeset/old-name.md', '.changeset/new-name.md');
      await commit(root, 'Rename the changeset');
      const trailer = synchronized ? added : start;
      const error = await rejectionOf(emit(root, await target(trailer), trailer));
      expect(error).toBeInstanceOf(ChangesetEmissionError);
      expect((error as Error).message).toContain('.changeset/new-name.md');
    }
  });

  test('a delete and re-add of the same name throws', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const first = await commit(root, 'Add a changeset');
    await git(root, 'rm', '--quiet', '.changeset/fix-a.md');
    const removed = await commit(root, 'Consume the changeset');
    await write(
      root,
      '.changeset/fix-a.md',
      changeset('@lostgradient/weft', 'Same name, new text.'),
    );
    await commit(root, 'Reuse the name');
    for (const trailer of [first, removed]) {
      const error = await rejectionOf(emit(root, await target(trailer), trailer));
      expect(error).toBeInstanceOf(ChangesetEmissionError);
      expect((error as Error).message).toContain('.changeset/fix-a.md');
    }
  });

  test('a squash that folds several edits into one commit passes and emits once', async () => {
    const { root, start } = await corvidae();
    await git(root, 'checkout', '--quiet', '-b', 'feature');
    await write(root, '.changeset/fix-a.md', weftChangeset);
    await commit(root, 'First draft');
    await write(root, '.changeset/fix-a.md', changeset('@lostgradient/cinder', 'Retargeted.'));
    await commit(root, 'Retarget');
    await write(root, '.changeset/fix-a.md', changeset('@lostgradient/weft', 'Final words.'));
    await commit(root, 'Final edit');
    await git(root, 'checkout', '--quiet', 'main');
    await git(root, 'merge', '--squash', '--quiet', 'feature');
    const squashed = await commit(root, 'Squashed pull request');
    const files = await emit(root, await target(start), start);
    expect(Object.keys(files)).toEqual([emittedPath(squashed, 'fix-a')]);
  });

  test('a delete and an add of a similar changeset in one commit throws, so the remedy is two pull requests', async () => {
    const { root } = await corvidae();
    const body =
      'Line one of a longer explanation.\nLine two keeps going.\nLine three too.\nLine four ends it.';
    await write(root, '.changeset/old-name.md', changeset('@lostgradient/weft', body));
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'rm', '--quiet', '.changeset/old-name.md');
    await write(
      root,
      '.changeset/new-name.md',
      changeset('@lostgradient/weft', `${body}\nLine five.`),
    );
    await commit(root, 'Replace it in one commit');
    const error = await rejectionOf(emit(root, await target(synced), synced));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain('.changeset/new-name.md');
  });

  test('the same replacement as two later commits passes and emits the new file', async () => {
    const { root } = await corvidae();
    const body =
      'Line one of a longer explanation.\nLine two keeps going.\nLine three too.\nLine four ends it.';
    await write(root, '.changeset/old-name.md', changeset('@lostgradient/weft', body));
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'rm', '--quiet', '.changeset/old-name.md');
    await commit(root, 'Delete it in one pull request');
    await write(
      root,
      '.changeset/new-name.md',
      changeset('@lostgradient/weft', `${body}\nLine five.`),
    );
    const added = await commit(root, 'Add the replacement later');
    const files = await emit(root, await target(synced), synced);
    expect(Object.keys(files)).toEqual([emittedPath(added, 'new-name')]);
  });

  test('a delete and an add of completely different changesets in one commit throws', async () => {
    const { root } = await corvidae();
    await write(
      root,
      '.changeset/old-name.md',
      changeset('@lostgradient/weft', 'Alpha beta gamma.'),
    );
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'rm', '--quiet', '.changeset/old-name.md');
    await write(
      root,
      '.changeset/new-name.md',
      '---\n"@lostgradient/cinder": major\n---\n\nNothing alike at all: zebra, quartz, voltage.\n',
    );
    await commit(root, 'Replace it in one commit');
    const error = await rejectionOf(emit(root, await target(synced), synced, 'cinder'));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain('.changeset/old-name.md');
    expect((error as Error).message).toContain('.changeset/new-name.md');
  });

  test('a merge commit whose first-parent diff deletes one changeset and adds another throws', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/old-name.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'checkout', '--quiet', '-b', 'side');
    await git(root, 'rm', '--quiet', '.changeset/old-name.md');
    await commit(root, 'Side: delete');
    await write(
      root,
      '.changeset/new-name.md',
      changeset('@lostgradient/weft', 'Different words.'),
    );
    await commit(root, 'Side: add');
    await git(root, 'checkout', '--quiet', 'main');
    await write(root, 'unrelated.txt', 'main moved\n');
    await commit(root, 'Main moves');
    await git(root, 'merge', '--quiet', '--no-ff', '--message', 'Merge side', 'side');
    const error = await rejectionOf(emit(root, await target(synced), synced));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain('.changeset/new-name.md');
  });

  test('two similar changesets added in different pull requests do not block each other', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/one.md', changeset('@lostgradient/weft', 'Fix the first thing.'));
    await commit(root, 'Add one');
    await write(
      root,
      '.changeset/two.md',
      changeset('@lostgradient/weft', 'Fix the second thing.'),
    );
    const second = await commit(root, 'Add two');
    const files = await emit(root, await target(start), start);
    expect(Object.keys(files)).toHaveLength(2);
    expect(Object.keys(files)).toContain(emittedPath(second, 'two'));
  });

  test('changeset paths are literal: names that only collide as patterns do not cross-match', async () => {
    const { root } = await corvidae();
    // Written directly: the validator would refuse the bracketed name.
    await write(root, '.changeset/fix[1].md', weftChangeset);
    await commit(root, 'Add the bracketed name');
    await write(root, '.changeset/fix1.md', weftChangeset);
    await commit(root, 'Add the plain name');
    await assertImmutable(root, ['.changeset/fix[1].md', '.changeset/fix1.md']);
  });

  describe('a package moving between mirrors', () => {
    const definitionsPath = 'scripts/mirror/target-definitions.ts';
    const packageMapPath = 'scripts/mirror/package-map.json';

    const definitions = (members: Record<string, string[]>): string =>
      `export const targetDefinitions = ${JSON.stringify(
        Object.fromEntries(
          ['weft', 'cinder', 'agent-bureau'].map((name) => [
            name,
            { members: members[name] ?? [] },
          ]),
        ),
      )};\n`;

    const map = (workspaces: string[], snapshot = ''): string =>
      `${JSON.stringify({
        workspaces: Object.fromEntries(
          workspaces.map((workspace) => [
            workspace,
            {
              disposition: 'publish-as',
              name: workspace,
              lastPublishedVersion: '1.0.0',
              ...(snapshot === '' ? {} : { publishedSnapshot: { version: snapshot } }),
            },
          ]),
        ),
      })}\n`;

    const weft = '@lostgradient/weft';
    const chat = '@lostgradient/chat';

    async function mapped(members: Record<string, string[]>, workspaces = [weft, chat]) {
      const { root } = await corvidae();
      await write(root, definitionsPath, definitions(members));
      await write(root, packageMapPath, map(workspaces));
      return { root, base: await commit(root, 'Mapping') };
    }

    test('a package moved while a changeset names it throws for every target, as in the double-release scenario', async () => {
      const { root, base } = await mapped({ cinder: [weft], weft: [] });
      // Z lands after weft's trailer and before cinder's trailer.
      await write(root, '.changeset/z.md', weftChangeset);
      const cinderTrailer = await commit(root, 'Add Z');
      await write(root, definitionsPath, definitions({ cinder: [], weft: [weft] }));
      await commit(root, 'Move the package from cinder to weft');
      for (const [mirror, trailer] of [
        ['weft', base],
        ['cinder', cinderTrailer],
      ] as const) {
        const error = await rejectionOf(emit(root, await target(trailer), trailer, mirror));
        expect(error).toBeInstanceOf(ChangesetEmissionError);
        const message = (error as Error).message;
        expect(message).toContain(weft);
        expect(message).toContain('cinder');
        expect(message).toContain('weft');
        expect(message).toContain('.changeset/z.md');
        expect(message).toContain(
          'after moving a package between mirrors, or starting or stopping its publication, sync every affected mirror once before adding changesets that name it; delete existing ones first',
        );
      }
    });

    test('a round trip A to B to A throws for both mirrors, whatever each trailer saw', async () => {
      const { root, base } = await mapped({ cinder: [weft], weft: [] });
      await write(root, '.changeset/z.md', weftChangeset);
      const cinderTrailer = await commit(root, 'Add Z');
      await write(root, definitionsPath, definitions({ cinder: [], weft: [weft] }));
      await commit(root, 'Move to weft');
      await write(root, definitionsPath, definitions({ cinder: [weft], weft: [] }));
      await commit(root, 'Move back to cinder');
      // The endpoints agree for the cinder plan; only the range shows the package moved.
      for (const [mirror, trailer] of [
        ['cinder', cinderTrailer],
        ['weft', base],
      ] as const) {
        const error = await rejectionOf(emit(root, await target(trailer), trailer, mirror));
        expect(error).toBeInstanceOf(ChangesetEmissionError);
        expect((error as Error).message).toContain(weft);
        expect((error as Error).message).toContain('.changeset/z.md');
      }
    });

    test('a changeset added and deleted inside the range around a move passes', async () => {
      const { root, base } = await mapped({ cinder: [weft], weft: [] });
      await write(root, '.changeset/z.md', weftChangeset);
      await commit(root, 'Add Z');
      await write(root, definitionsPath, definitions({ cinder: [], weft: [weft] }));
      await commit(root, 'Move to weft');
      await git(root, 'rm', '--quiet', '.changeset/z.md');
      await commit(root, 'Consume Z');
      await write(root, definitionsPath, definitions({ cinder: [weft], weft: [] }));
      await commit(root, 'Move back');
      expect(await emit(root, await target(base), base, 'cinder')).toEqual({});
    });

    test('deleting the changesets and then moving the package, in later commits, passes', async () => {
      const { root, base } = await mapped({ cinder: [weft], weft: [] });
      await write(root, '.changeset/z.md', weftChangeset);
      await commit(root, 'Add Z');
      await git(root, 'rm', '--quiet', '.changeset/z.md');
      await commit(root, 'Delete the changesets');
      await write(root, definitionsPath, definitions({ cinder: [], weft: [weft] }));
      await commit(root, 'Move the package');
      for (const mirror of ['cinder', 'weft'] as const) {
        expect(await emit(root, await target(base), base, mirror)).toEqual({});
      }
    });

    test('removing a package from one mirror and adding it to another, in two commits, throws', async () => {
      const { root, base } = await mapped({ cinder: [weft], weft: [] });
      await write(root, definitionsPath, definitions({ cinder: [], weft: [] }));
      await commit(root, 'Remove it from cinder');
      await write(root, definitionsPath, definitions({ cinder: [], weft: [weft] }));
      await commit(root, 'Add it to weft');
      await write(root, '.changeset/z.md', weftChangeset);
      await commit(root, 'Add Z');
      const error = await rejectionOf(emit(root, await target(base), base));
      expect(error).toBeInstanceOf(ChangesetEmissionError);
      expect((error as Error).message).toContain('unowned');
    });

    test('an ambiguous owner with a changeset naming the package throws', async () => {
      const { root, base } = await mapped({ cinder: [weft], weft: [] });
      await write(root, definitionsPath, definitions({ cinder: [weft], weft: [weft] }));
      await commit(root, 'List it in two mirrors');
      await write(root, '.changeset/z.md', weftChangeset);
      await commit(root, 'Add Z');
      const error = await rejectionOf(emit(root, await target(base), base));
      expect(error).toBeInstanceOf(ChangesetEmissionError);
      expect((error as Error).message).toContain('ambiguous');
    });

    test('a round trip of a package no changeset names passes', async () => {
      const { root } = await mapped({ weft: [weft], cinder: [chat] });
      await write(root, '.changeset/z.md', weftChangeset);
      const synced = await commit(root, 'Add Z');
      await write(root, definitionsPath, definitions({ weft: [weft, chat], cinder: [] }));
      await commit(root, 'Move chat to weft');
      await write(root, definitionsPath, definitions({ weft: [weft], cinder: [chat] }));
      await commit(root, 'Move chat back');
      expect(await emit(root, await target(synced), synced)).toEqual({});
    });

    test('a package that starts publication cannot carry a changeset until a sync has passed it', async () => {
      const { root, base } = await mapped({ cinder: [chat], weft: [] }, [chat]);
      await write(root, definitionsPath, definitions({ cinder: [chat], weft: [weft] }));
      await write(root, packageMapPath, map([chat, weft]));
      await commit(root, 'Start publishing weft');
      await write(root, '.changeset/z.md', weftChangeset);
      await commit(root, 'Add Z');
      const error = await rejectionOf(emit(root, await target(base), base));
      expect(error).toBeInstanceOf(ChangesetEmissionError);
      expect((error as Error).message).toContain('not-published');
      expect((error as Error).message).toContain(
        'after moving a package between mirrors, or starting or stopping its publication, sync every affected mirror once before adding changesets that name it; delete existing ones first',
      );
    });

    test('a package that stops publication throws while a changeset names it', async () => {
      const { root, base } = await mapped({ weft: [weft] }, [weft]);
      await write(root, '.changeset/z.md', weftChangeset);
      await commit(root, 'Add Z');
      await write(root, packageMapPath, map([]));
      await commit(root, 'Stop publishing');
      expect(await rejectionOf(emit(root, await target(base), base))).toBeInstanceOf(
        ChangesetEmissionError,
      );
    });

    test('after one sync has passed a new package, a changeset naming it is accepted', async () => {
      const { root } = await mapped({ weft: [weft] }, [weft]);
      await write(root, definitionsPath, definitions({ weft: [weft], cinder: [chat] }));
      await write(root, packageMapPath, map([weft, chat]));
      const trailer = await commit(root, 'Start publishing chat');
      await write(root, '.changeset/z.md', changeset('@lostgradient/chat'));
      const adding = await commit(root, 'Add Z');
      const files = await emit(root, await target(trailer), trailer, 'cinder');
      expect(Object.keys(files)).toEqual([emittedPath(adding, 'z')]);
    });

    test('adding a new publish-as workspace with changesets present passes', async () => {
      const { root } = await mapped({ weft: [weft] }, [weft]);
      await write(root, '.changeset/z.md', weftChangeset);
      const synced = await commit(root, 'Add Z');
      await write(root, definitionsPath, definitions({ weft: [weft], cinder: [chat] }));
      await write(root, packageMapPath, map([weft, chat]));
      await commit(root, 'Add a workspace');
      expect(await emit(root, await target(synced), synced)).toEqual({});
    });

    test('removing a workspace and recording a snapshot are not moves', async () => {
      const { root } = await mapped({ weft: [weft], cinder: [chat] });
      await write(root, '.changeset/z.md', weftChangeset);
      const synced = await commit(root, 'Add Z');
      await write(root, definitionsPath, definitions({ weft: [weft] }));
      await write(root, packageMapPath, map([weft], '1.0.1'));
      await commit(root, 'Remove a workspace and record a snapshot');
      expect(await emit(root, await target(synced), synced)).toEqual({});
    });

    test('a move of a package that no changeset names passes', async () => {
      const { root } = await mapped({ weft: [weft], cinder: [chat] });
      await write(root, '.changeset/z.md', weftChangeset);
      const synced = await commit(root, 'Add Z');
      await write(root, definitionsPath, definitions({ weft: [weft, chat], cinder: [] }));
      await commit(root, 'Move chat');
      expect(await emit(root, await target(synced), synced)).toEqual({});
    });

    test('a trailer mapping that cannot be resolved fails closed', async () => {
      const { root } = await mapped({ weft: [weft] }, [weft]);
      await write(root, '.changeset/z.md', weftChangeset);
      const synced = await commit(root, 'Add Z');
      await write(root, definitionsPath, 'this is not a module (\n');
      const broken = await commit(root, 'Break the mapping at the trailer');
      await write(root, definitionsPath, definitions({ weft: [], cinder: [weft] }));
      await commit(root, 'Repair it, moved');
      expect(await rejectionOf(emit(root, await target(broken), broken))).toBeInstanceOf(
        ChangesetEmissionError,
      );
      expect(synced).not.toBe(broken);
    });
  });
});
