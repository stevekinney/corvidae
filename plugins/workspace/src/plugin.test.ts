import { describe, expect, test } from 'bun:test';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import plugin from './plugin.ts';

const context = { secrets: { get: async () => undefined } };

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

async function roots() {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-plugin-'));
  const docs = join(directory, 'docs');
  const source = join(directory, 'source');
  await Bun.write(join(docs, 'readme.md'), 'docs');
  await Bun.write(join(source, 'index.ts'), 'source');
  return { directory, docs, source };
}

describe('the workspace plugin', () => {
  test('contributes three namespaced tools per configured root', async () => {
    const fixture = await roots();
    const result = await plugin.setup?.({
      ...context,
      configuration: {
        roots: [
          { id: 'docs', path: fixture.docs, description: 'Documentation.' },
          { id: 'source', path: fixture.source, description: 'Source code.' },
        ],
      },
    } as never);

    expect(result?.tools?.map((tool) => tool.name)).toEqual([
      'docs-glob',
      'docs-grep',
      'docs-read-file',
      'source-glob',
      'source-grep',
      'source-read-file',
    ]);
    expect(result?.tools?.every((tool) => tool.metadata?.readOnly === true)).toBe(true);
    expect(result?.tools?.find((tool) => tool.name === 'docs-read-file')?.description).toContain(
      'Documentation.',
    );
  });

  test.each([
    [
      'duplicate id',
      (fixture: Awaited<ReturnType<typeof roots>>) => ({
        roots: [
          { id: 'docs', path: fixture.docs, description: 'One.' },
          { id: 'docs', path: fixture.source, description: 'Two.' },
        ],
      }),
      'docs',
    ],
    [
      'relative path',
      () => ({
        roots: [{ id: 'docs', path: 'docs', description: 'Docs.' }],
      }),
      'docs',
    ],
    [
      'missing directory',
      (fixture: Awaited<ReturnType<typeof roots>>) => ({
        roots: [
          { id: 'missing', path: join(fixture.directory, 'missing'), description: 'Missing.' },
        ],
      }),
      'missing',
    ],
  ] as const)('rejects %s during setup and names the offending root', async (_, make, id) => {
    const fixture = await roots();
    expect(() => plugin.setup?.({ ...context, configuration: make(fixture) } as never)).toThrow(id);
  });

  test('refuses parent traversal, absolute paths, and symlinks escaping the root', async () => {
    const fixture = await roots();
    const outside = join(fixture.directory, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(fixture.docs, 'outside-link.txt'));
    const result = await plugin.setup?.({
      ...context,
      configuration: { roots: [{ id: 'docs', path: fixture.docs, description: 'Docs.' }] },
    } as never);
    const read = result?.tools?.find((tool) => tool.name === 'docs-read-file');
    expect(read).toBeDefined();
    expect(await rejectionOf(read!.execute({ path: '../outside.txt' }))).toBeInstanceOf(Error);
    expect(await rejectionOf(read!.execute({ path: outside }))).toBeInstanceOf(Error);
    expect(await rejectionOf(read!.execute({ path: 'outside-link.txt' }))).toBeInstanceOf(Error);
  });
});
