import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { rejectionOf } from '../promise-outcome.test-support.ts';
import { ChangesetEmissionError, planChangesetEmission } from './changeset-emission.ts';
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

  test('(c) does not emit a file modified after it synced', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    await write(root, '.changeset/fix-a.md', changeset('@lostgradient/weft', 'A better sentence.'));
    await commit(root, 'Edit the changeset');
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

  test('(e) a rename before the sync emits the file once, under its new name', async () => {
    const { root, start } = await corvidae();
    await write(root, '.changeset/old-name.md', weftChangeset);
    await commit(root, 'Add a changeset');
    await git(root, 'mv', '.changeset/old-name.md', '.changeset/new-name.md');
    const renamed = await commit(root, 'Rename the changeset');
    const files = await emit(root, await target(start), start);
    expect(Object.keys(files)).toEqual([emittedPath(renamed, 'new-name')]);
  });

  test('(e2) a rename after the sync throws and names both files', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/old-name.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'mv', '.changeset/old-name.md', '.changeset/new-name.md');
    await commit(root, 'Rename the changeset');
    const error = await rejectionOf(emit(root, await target(synced), synced));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain('.changeset/old-name.md');
    expect((error as Error).message).toContain('.changeset/new-name.md');
  });

  test('(e2) a rename that also edits the file after the sync throws and names both files', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/old-name.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'mv', '.changeset/old-name.md', '.changeset/new-name.md');
    await write(
      root,
      '.changeset/new-name.md',
      changeset('@lostgradient/weft', 'Fix the thing.\n\nAnd one more sentence.'),
    );
    await commit(root, 'Rename and edit the changeset');
    const error = await rejectionOf(emit(root, await target(synced), synced));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain('.changeset/old-name.md');
    expect((error as Error).message).toContain('.changeset/new-name.md');
  });

  test('(e2) a rename that git cannot see because the whole file was rewritten still throws', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/old-name.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'rm', '--quiet', '.changeset/old-name.md');
    await write(
      root,
      '.changeset/new-name.md',
      '---\n"@lostgradient/weft": minor\n---\n\nEntirely different words about another subject.\n',
    );
    await commit(root, 'Delete one changeset and add another in one commit');
    const detected = await git(
      root,
      'log',
      '--find-renames',
      '--diff-filter=R',
      '--format=%H',
      '-1',
    );
    expect(detected.trim()).toBe('');
    const error = await rejectionOf(emit(root, await target(synced), synced));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain('.changeset/old-name.md');
    expect((error as Error).message).toContain('.changeset/new-name.md');
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

  test('(g2) a later changeset reusing a consumed name is emitted under a new path', async () => {
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
    const reused = await commit(root, 'Reuse the name');
    const clone = await target(removed);
    await write(clone, emittedPath(first, 'fix-a'), weftChangeset);
    await commit(clone, 'The first copy synced');
    await git(clone, 'rm', '--quiet', emittedPath(first, 'fix-a'));
    await commit(clone, 'Version Packages');

    expect(Object.keys(await emit(root, clone, removed))).toEqual([emittedPath(reused, 'fix-a')]);
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

  test('a name that existed at the trailer and was deleted and re-added in the range throws', async () => {
    const { root } = await corvidae();
    await write(root, '.changeset/fix-a.md', weftChangeset);
    const synced = await commit(root, 'Add a changeset');
    await git(root, 'rm', '--quiet', '.changeset/fix-a.md');
    await commit(root, 'Consume the changeset');
    await write(
      root,
      '.changeset/fix-a.md',
      changeset('@lostgradient/weft', 'Same name, new text.'),
    );
    await commit(root, 'Reuse the name');
    const error = await rejectionOf(emit(root, await target(synced), synced));
    expect(error).toBeInstanceOf(ChangesetEmissionError);
    expect((error as Error).message).toContain('.changeset/fix-a.md');
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
});
