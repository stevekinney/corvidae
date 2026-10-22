import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { directoryGlob, workspaceParentDirectories } from './workspace-directories';

/**
 * The `--cinder-status-*-solid` tokens are fills tuned to carry a contrasting label, and in the
 * light theme the warning and success fills are too light to be text or an icon on a raised
 * surface (about 1.98:1 and 3.67:1). Anything drawn in the foreground uses the matching
 * `--cinder-status-*-text` token instead. This guard fails when a `color` declaration takes a
 * `-solid` token directly, in any workspace's component or application styling.
 */
const root = join(import.meta.dir, '..');

const solidAsForeground = /(?<![\w-])color\s*:\s*var\(\s*--cinder-status-[a-z]+-solid\b/g;

async function sourceFiles(): Promise<string[]> {
  const glob = new Bun.Glob(
    `${directoryGlob(workspaceParentDirectories)}/**/*.{css,svelte,ts,tsx,html}`,
  );
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
    if (/(^|\/)(node_modules|\.types|dist|build|test-output|\.svelte-kit)\//.test(file)) continue;
    if (/\.(test|spec)\.ts$|\/documentation\//.test(file)) continue;
    files.push(file);
  }
  return files;
}

describe('status fills as foreground colors', () => {
  test('no component or application sets `color` to a `--cinder-status-*-solid` token', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const contents = await Bun.file(join(root, file)).text();
      const lines = contents.split('\n');
      lines.forEach((line, index) => {
        solidAsForeground.lastIndex = 0;
        if (solidAsForeground.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the diff summary bar and the export confirmation use the status text tokens', async () => {
    const summaryBar = await Bun.file(
      join(root, 'components/editor/src/lib/components/diff-viewer/diff-summary-bar.svelte'),
    ).text();
    expect(summaryBar).toMatch(
      /\.stat-modified\s*\{[^}]*color:\s*var\(--cinder-status-warning-text\)/,
    );

    const exportActions = await Bun.file(
      join(root, 'components/editor/src/lib/components/review-editor/export-actions.svelte'),
    ).text();
    expect(exportActions).toMatch(
      /\.copied-label\s*\{[^}]*color:\s*var\(--cinder-status-success-text\)/,
    );
  });

  test('the toast icon takes its colour from a text token, not the stripe fill', async () => {
    const css = await Bun.file(
      join(root, 'components/cinder/src/components/toast-region/toast-region.css'),
    ).text();
    expect(css).not.toMatch(/color:\s*var\(--_cinder-toast-accent,/);
    expect(css).toContain('--_cinder-toast-accent-text: var(--cinder-status-warning-text)');
  });

  test('hit-target expansions react to any coarse pointer, so hybrid devices get them too', async () => {
    const send = await Bun.file(
      join(root, 'components/chat/src/lib/components/chat/input/chat-input.svelte'),
    ).text();
    expect(send).toMatch(/@media \(any-pointer: coarse\) \{\s*\.chat-input-send::after/);
    const toggle = await Bun.file(
      join(root, 'components/cinder/src/components/toggle/toggle.css'),
    ).text();
    expect(toggle).toContain('@media (any-pointer: coarse)');
    expect(toggle).not.toMatch(/@media \(pointer: coarse\)/);
  });
});
