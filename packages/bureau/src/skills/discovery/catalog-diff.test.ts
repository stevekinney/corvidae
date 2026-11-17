/**
 * COR-2100 (E4c) — `diffSkillCatalogs`: what changed between two discoveries of the skill sources,
 * by name. Each row is a state of two real skill roots, a change made to them, and the lists the
 * diff must give, from `EVT-3-matrix.md` (`line` is the row's line in that file). The rows read the
 * disk through `discoverSkills`, never a hand-built catalog, so what a record or a diagnostic
 * carries is what discovery really produces.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diffSkillCatalogs, type SkillCatalogChange } from './catalog.ts';
import { discoverSkills } from './discover.ts';

const scratch: string[] = [];
afterEach(async () => {
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** What a skill file holds. */
const skill = (name: string, description = 'Does things.', body = 'Body.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

interface Roots {
  /** The `project` source, precedence 10. */
  readonly project: string;
  /** The `user` source, precedence 20. */
  readonly user: string;
  /** A directory outside both roots, for staging a directory to rename in. */
  readonly staging: string;
}

/** Writes `files` under `root/directory`. */
async function put(
  root: string,
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, directory, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, text);
  }
}

async function discover(roots: Roots) {
  return discoverSkills({
    sources: [
      { id: 'project', kind: 'project', location: roots.project, precedence: 10 },
      { id: 'user', kind: 'user', location: roots.user, precedence: 20 },
    ],
    trustPolicy: { decide: () => ({ state: 'trusted', reason: 'A fixture.' }) },
  });
}

const NONE: SkillCatalogChange = { added: [], changed: [], removed: [], rejected: [] };
const change = (parts: Partial<SkillCatalogChange>): SkillCatalogChange => ({ ...NONE, ...parts });

interface Row {
  readonly line: number;
  readonly source: string;
  readonly name: string;
  /** The state before the change. */
  readonly before?: (roots: Roots) => Promise<void>;
  /** The change made. */
  readonly after: (roots: Roots) => Promise<void>;
  readonly expected: SkillCatalogChange;
}

const ROWS: readonly Row[] = [
  {
    line: 88,
    source: 'AC1',
    name: 'a directory with a valid SKILL.md is added',
    after: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    expected: change({ added: ['alpha'] }),
  },
  {
    line: 89,
    source: 'AC1',
    name: 'SKILL.md content changed is changed',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    after: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha', 'Does more.') }),
    expected: change({ changed: ['alpha'] }),
  },
  {
    line: 90,
    source: 'Rev 2026-11-15 (compares artifactDigest)',
    name: 'a resource file of a skill added is changed',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    after: (roots) => put(roots.user, 'alpha', { 'references/notes.md': 'Notes.\n' }),
    expected: change({ changed: ['alpha'] }),
  },
  {
    line: 91,
    source: 'AC1',
    name: 'a skill directory removed is removed',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    after: (roots) => rm(join(roots.user, 'alpha'), { recursive: true }),
    expected: change({ removed: ['alpha'] }),
  },
  {
    line: 92,
    source: 'AC2, Rev 2026-11-15',
    name: 'frontmatter without a description is added and rejected',
    after: (roots) => put(roots.user, 'alpha', { 'SKILL.md': '---\nname: alpha\n---\n\nBody.\n' }),
    expected: change({ added: ['alpha'], rejected: ['alpha'] }),
  },
  {
    line: 93,
    source: 'Rev',
    name: 'a skill that becomes unparseable is changed and rejected, not removed, keyed on its directory',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    after: (roots) =>
      put(roots.user, 'alpha', { 'SKILL.md': '---\nname: alpha\ndescription: [unclosed\n---\n' }),
    expected: change({ changed: ['alpha'], rejected: ['alpha'] }),
  },
  {
    line: 94,
    source: 'O-C3',
    name: 'a skill whose declared name differs from its directory and that becomes unparseable is removed under its name and added and rejected under its directory',
    before: (roots) => put(roots.user, 'alpha-renamed', { 'SKILL.md': skill('beta') }),
    after: (roots) =>
      put(roots.user, 'alpha-renamed', {
        'SKILL.md': '---\nname: beta\ndescription: [unclosed\n---\n',
      }),
    expected: change({ removed: ['beta'], added: ['alpha-renamed'], rejected: ['alpha-renamed'] }),
  },
  {
    line: 95,
    source: 'O-C2',
    name: 'a full write after an empty SKILL.md is changed without rejected, keyed on the directory both times',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': '' }),
    after: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    expected: change({ changed: ['alpha'] }),
  },
  {
    line: 95,
    source: 'O-C2; matrix line 126 (names carried)',
    name: 'an empty SKILL.md is added and rejected under its directory name, not under an empty one',
    after: (roots) => put(roots.user, 'alpha', { 'SKILL.md': '' }),
    expected: change({ added: ['alpha'], rejected: ['alpha'] }),
  },
  {
    line: 96,
    source: 'Rev, O-C1',
    name: 'the full write after frontmatter that was cut off is changed without rejected',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': '---\nname: alpha\ndescr' }),
    after: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    expected: change({ changed: ['alpha'] }),
  },
  {
    line: 96,
    source: 'Rev, O-C1',
    name: 'frontmatter cut off, seen first, is added and rejected',
    after: (roots) => put(roots.user, 'alpha', { 'SKILL.md': '---\nname: alpha\ndescr' }),
    expected: change({ added: ['alpha'], rejected: ['alpha'] }),
  },
  {
    line: 97,
    source: 'O-C1',
    name: 'a directory made with no SKILL.md yet reports nothing',
    after: (roots) => mkdir(join(roots.user, 'alpha')),
    expected: NONE,
  },
  {
    line: 98,
    source: 'Rev 2026-11-15',
    name: 'a file touched with no content change reports nothing',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    after: (roots) => utimes(join(roots.user, 'alpha', 'SKILL.md'), new Date(), new Date(1)),
    expected: NONE,
  },
  {
    line: 100,
    source: 'Rev 2026-11-15, O-C11',
    name: 'a directory renamed with the declared name unchanged reports nothing',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    after: (roots) => rename(join(roots.user, 'alpha'), join(roots.user, 'alpha-two')),
    expected: NONE,
  },
  {
    line: 101,
    source: 'Rev 2026-11-15',
    name: 'a declared name changed is the old name removed and the new one added',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    after: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('beta') }),
    expected: change({ removed: ['alpha'], added: ['beta'] }),
  },
  {
    line: 102,
    source: 'Rev 2026-11-15',
    name: 'a skill moved to another source is changed',
    before: (roots) => put(roots.project, 'beta', { 'SKILL.md': skill('beta') }),
    after: async (roots) => {
      await rename(join(roots.project, 'beta'), join(roots.user, 'beta'));
    },
    expected: change({ changed: ['beta'] }),
  },
  {
    line: 103,
    source: 'Rev 2026-11-15',
    name: 'a higher layer that adds a copy shadowing the lower one is changed',
    before: (roots) => put(roots.user, 'beta', { 'SKILL.md': skill('beta') }),
    after: (roots) =>
      put(roots.project, 'beta', { 'SKILL.md': skill('beta', 'The project’s own.') }),
    expected: change({ changed: ['beta'] }),
  },
  {
    line: 104,
    source: 'Rev 2026-11-15, O-C5',
    name: 'the shadowed lower copy edited is changed though the winner is unchanged',
    before: async (roots) => {
      await put(roots.user, 'beta', { 'SKILL.md': skill('beta') });
      await put(roots.project, 'beta', { 'SKILL.md': skill('beta', 'The project’s own.') });
    },
    after: (roots) => put(roots.user, 'beta', { 'SKILL.md': skill('beta', 'Edited below.') }),
    expected: change({ changed: ['beta'] }),
  },
  {
    line: 105,
    source: 'Rev 2026-11-15',
    name: 'two directories in one source that declare one name are changed',
    before: (roots) => put(roots.project, 'beta', { 'SKILL.md': skill('beta') }),
    after: (roots) => put(roots.project, 'gamma', { 'SKILL.md': skill('beta', 'The other.') }),
    expected: change({ changed: ['beta'] }),
  },
  {
    line: 108,
    source: 'Rev 2026-11-15',
    name: 'a source root removed removes the records under it',
    before: (roots) => put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') }),
    after: (roots) => rm(roots.user, { recursive: true }),
    expected: change({ removed: ['alpha'] }),
  },
  {
    line: 127,
    source: 'Rev',
    name: 'a diagnostic seen again unchanged is not reported again',
    before: (roots) =>
      put(roots.user, 'alpha', { 'SKILL.md': '---\nname: alpha\ndescription: [unclosed\n---\n' }),
    after: (roots) =>
      // Another skill changes meanwhile: only that one is reported.
      put(roots.user, 'beta', { 'SKILL.md': skill('beta') }),
    expected: change({ added: ['beta'] }),
  },
];

describe('diffSkillCatalogs over real skill roots (event feed batch 3, COR-2100)', () => {
  for (const row of ROWS) {
    it(`[COR-2100, matrix line ${row.line}, ${row.source}] ${row.name}`, async () => {
      const base = await mkdtemp(join(tmpdir(), 'skill-diff-'));
      scratch.push(base);
      const roots: Roots = {
        project: join(base, 'project'),
        user: join(base, 'user'),
        staging: join(base, 'staging'),
      };
      for (const root of Object.values(roots)) await mkdir(root, { recursive: true });
      await row.before?.(roots);
      const previous = await discover(roots);
      await row.after(roots);
      const next = await discover(roots);
      expect(diffSkillCatalogs(previous, next)).toEqual(row.expected);
    });
  }

  it('[COR-2100, matrix line 88] lists each name once, in order, whatever the number of records', async () => {
    const base = await mkdtemp(join(tmpdir(), 'skill-diff-'));
    scratch.push(base);
    const roots: Roots = {
      project: join(base, 'project'),
      user: join(base, 'user'),
      staging: join(base, 'staging'),
    };
    for (const root of Object.values(roots)) await mkdir(root, { recursive: true });
    const previous = await discover(roots);
    await put(roots.user, 'zulu', { 'SKILL.md': skill('zulu') });
    await put(roots.project, 'zulu', { 'SKILL.md': skill('zulu', 'Own.') });
    await put(roots.user, 'alpha', { 'SKILL.md': skill('alpha') });
    expect(diffSkillCatalogs(previous, await discover(roots))).toEqual(
      change({ added: ['alpha', 'zulu'] }),
    );
  });

  it('[COR-2100, matrix line 93] names the directory on an admission-failed diagnostic', async () => {
    const base = await mkdtemp(join(tmpdir(), 'skill-diff-'));
    scratch.push(base);
    const roots: Roots = {
      project: join(base, 'project'),
      user: join(base, 'user'),
      staging: join(base, 'staging'),
    };
    for (const root of Object.values(roots)) await mkdir(root, { recursive: true });
    await put(roots.user, 'alpha', {
      'SKILL.md': '---\nname: alpha\ndescription: [unclosed\n---\n',
    });
    const catalog = await discover(roots);
    const failed = catalog.sourceDiagnostics.filter(
      (diagnostic) => diagnostic.code === 'admission-failed',
    );
    expect(failed.map((diagnostic) => diagnostic.directoryName)).toEqual(['alpha']);
  });
});
