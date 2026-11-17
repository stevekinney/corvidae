import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** The `path:` block of every upload step in `text` that uploads JUnit reports. */
function junitUploadPaths(text: string): string[][] {
  const blocks: string[][] = [];
  for (const match of text.matchAll(/^(\s*)path: \|\n((?:\1 {2}.*\n)+)/gm)) {
    const lines = (match[2] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.some((line) => line.includes('test-output/junit'))) blocks.push(lines);
  }
  return blocks;
}

// The upload walked every node_modules under a `**/test-output/junit/*.xml` glob, `!` exclusions
// notwithstanding, and ran past the job limit once the package split made 191 component
// workspaces. Each upload names the workspace roots instead, so it never descends into a package.
test('JUnit uploads name each workspace root, never a recursive glob', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces: string[];
  };
  const expected = [
    'test-output/junit/*.xml',
    ...manifest.workspaces.map((pattern) => `${pattern}/test-output/junit/*.xml`),
  ];
  const workflow = readFileSync(join(root, '.github/workflows/main.yml'), 'utf8');
  const blocks = junitUploadPaths(workflow);
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) expect(block).toEqual(expected);
});
