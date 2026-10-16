import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { rejectionOf } from '../promise-outcome.test-support.ts';
import {
  ChangesetError,
  assertChangesetFileName,
  listChangesetFiles,
  parseChangeset,
  targetOfChangeset,
  validateChangeset,
} from './changesets.ts';

const body = 'Fix the thing.\n';

function changeset(frontmatter: readonly string[], text = body, newline = '\n'): string {
  return ['---', ...frontmatter, '---', '', text].join(newline);
}

describe('parseChangeset', () => {
  test('reads names and bumps from standard changeset Markdown', () => {
    const parsed = parseChangeset(changeset(['"@lostgradient/weft": patch']));
    expect(parsed.bumps).toEqual([{ name: '@lostgradient/weft', bump: 'patch' }]);
    expect(parsed.body.trim()).toBe('Fix the thing.');
  });

  test('accepts CRLF line endings', () => {
    const parsed = parseChangeset(changeset(['"@lostgradient/weft": minor'], body, '\r\n'));
    expect(parsed.bumps).toEqual([{ name: '@lostgradient/weft', bump: 'minor' }]);
  });

  test('accepts single quotes, double quotes and an unscoped name', () => {
    const parsed = parseChangeset(
      changeset([
        "'@lostgradient/cinder': major",
        '"@lostgradient/editor": patch',
        'unscoped-package: patch',
      ]),
    );
    expect(parsed.bumps.map(({ name }) => name)).toEqual([
      '@lostgradient/cinder',
      '@lostgradient/editor',
      'unscoped-package',
    ]);
  });

  test.each([
    ['prerelease', ['"@lostgradient/weft": prerelease']],
    ['none', ['"@lostgradient/weft": none']],
    ['a comment', ['# explain', '"@lostgradient/weft": patch']],
    ['empty frontmatter', []],
    ['mismatched quotes', ['"@lostgradient/weft\': patch']],
    ['a repeated name', ['"@lostgradient/weft": patch', '"@lostgradient/weft": minor']],
  ])('rejects %s', (_label, frontmatter) => {
    expect(() => parseChangeset(changeset(frontmatter))).toThrow(ChangesetError);
  });

  test('rejects an empty body', () => {
    expect(() => parseChangeset(changeset(['"@lostgradient/weft": patch'], '  \n'))).toThrow(
      /body/,
    );
  });

  test('rejects text without frontmatter', () => {
    expect(() => parseChangeset('Just prose.\n')).toThrow(ChangesetError);
  });
});

describe('validateChangeset', () => {
  test('accepts a single-target changeset and names its target', async () => {
    expect(await validateChangeset(changeset(['"@lostgradient/weft": patch']))).toBe('weft');
    expect(
      await validateChangeset(
        changeset(['"@lostgradient/editor": patch', '"@lostgradient/markdown": minor']),
      ),
    ).toBe('cinder');
  });

  test('accepts CRLF and double-quoted fixtures', async () => {
    expect(
      await validateChangeset(changeset(['"@lostgradient/cinder": patch'], body, '\r\n')),
    ).toBe('cinder');
  });

  test('rejects names spanning two targets', async () => {
    const error = await rejectionOf(
      validateChangeset(
        changeset(['"@lostgradient/weft": patch', '"@lostgradient/cinder": patch']),
      ),
    );
    expect(error).toBeInstanceOf(ChangesetError);
    expect((error as Error).message).toMatch(/one target/);
  });

  test('rejects an unknown name', async () => {
    const error = await rejectionOf(
      validateChangeset(changeset(['"@lostgradient/not-a-package": patch'])),
    );
    expect((error as Error).message).toContain('@lostgradient/not-a-package');
  });

  test.each(['@lostgradient/testing', '@lostgradient/typescript'])(
    'rejects the private workspace %s',
    async (name) => {
      const error = await rejectionOf(validateChangeset(changeset([`"${name}": patch`])));
      expect(error).toBeInstanceOf(ChangesetError);
    },
  );

  test('rejects @lostgradient/weft-ui, a workspace no longer, since COR-1455 folded it into Weft', async () => {
    const error = await rejectionOf(
      validateChangeset(changeset(['"@lostgradient/weft-ui": patch'])),
    );
    expect(error).toBeInstanceOf(ChangesetError);
    expect((error as Error).message).toContain('@lostgradient/weft-ui');
  });

  /**
   * The owner stopped publishing these on 2026-10-14. A changeset naming one has no mirror to
   * release it, so it is refused here rather than carried to a target that no longer ships it.
   */
  test.each([
    '@lostgradient/chat',
    '@lostgradient/operative',
    'armorer',
    'conversationalist',
    '@lostgradient/cryptography',
    '@lostgradient/embeddings',
    '@lostgradient/tool-protocol',
    '@lostgradient/lifecycle',
  ])('rejects the retired package %s', async (name) => {
    const error = await rejectionOf(validateChangeset(changeset([`"${name}": patch`])));
    expect(error).toBeInstanceOf(ChangesetError);
    expect((error as Error).message).toContain('not the npm name of a publish-as workspace');
  });

  test('rejects prerelease, none, empty frontmatter and an empty body', async () => {
    for (const text of [
      changeset(['"@lostgradient/weft": prerelease']),
      changeset(['"@lostgradient/weft": none']),
      changeset([]),
      changeset(['"@lostgradient/weft": patch'], '\n'),
    ]) {
      expect(await rejectionOf(validateChangeset(text))).toBeInstanceOf(ChangesetError);
    }
  });

  test('targetOfChangeset resolves a parsed changeset without re-reading the text', async () => {
    const parsed = parseChangeset(changeset(['"@lostgradient/editor": patch']));
    expect(await targetOfChangeset(parsed)).toBe('cinder');
  });
});

describe('assertChangesetFileName', () => {
  test('accepts conservative lowercase names', () => {
    for (const name of ['fix-a.md', 'a.md', 'v2.fix_1.md', '0-first.md']) {
      expect(() => assertChangesetFileName(`.changeset/${name}`)).not.toThrow();
    }
  });

  test('caps the filename at 200 characters so the emitted name stays under 255 bytes', () => {
    const ofLength = (length: number): string =>
      `.changeset/${'a'.repeat(length - '.md'.length)}.md`;
    expect(() => assertChangesetFileName(ofLength(200))).not.toThrow();
    expect(() => assertChangesetFileName(ofLength(201))).toThrow(/200 characters/);
  });

  test.each(['fix[1].md', 'Fix.md', '-lead.md', 'a b.md', 'a*.md', 'é.md', '.hidden.md', 'a.txt'])(
    'rejects %s',
    (name) => {
      expect(() => assertChangesetFileName(`.changeset/${name}`)).toThrow(/lowercase|filename/i);
    },
  );
});

describe('the corvidae .changeset directory', () => {
  test('every real changeset validates', async () => {
    const root = join(import.meta.dir, '..', '..');
    for (const file of await listChangesetFiles(root)) {
      const text = await Bun.file(join(root, file)).text();
      assertChangesetFileName(file);
      await validateChangeset(text, file);
    }
  });

  test('holds a README stating the authoring rules', async () => {
    const root = join(import.meta.dir, '..', '..', '.changeset');
    expect(await readdir(root)).toContain('README.md');
    const readme = await Bun.file(join(root, 'README.md')).text();
    expect(readme).toMatch(/one target/i);
    expect(readme).toMatch(/immutable/i);
    expect(readme).toMatch(/fix it in the target/i);
  });
});
