import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { directoryGlob, workspaceParentDirectories } from './workspace-directories';

/**
 * The `--cinder-status-*-solid` tokens are fills tuned to carry a contrasting label, and in the
 * light theme the warning and success fills are too light to be text or an icon on a raised
 * surface (about 1.98:1 and 3.67:1). Anything drawn in the foreground uses the matching
 * `--cinder-status-*-text` token instead. This guard fails when a `color` declaration takes a
 * `-solid` token directly, or through one level of custom-property aliasing, and when a
 * `outline-color` or `--cinder-focus-ring-color` does, in any workspace's component or
 * application styling.
 */
const root = join(import.meta.dir, '..');

const solidAsForeground = /(?<![\w-])color\s*:\s*var\(\s*--cinder-status-[a-z]+-solid\b/g;

/** A custom property that is nothing but a `-solid` status token: `--x: var(--cinder-status-*-solid)`. */
const solidAlias = /(--[\w-]+)\s*:\s*var\(\s*--cinder-status-[a-z]+-solid\s*[,)]/g;

/** The declarations that paint something a reader must see against its surface: text, icon, outline. */
const foregroundDeclaration =
  /(?<![\w-])(?:color|outline-color|--cinder-focus-ring-color)\s*:\s*var\(\s*(--[\w-]+)(?![\w-])/g;

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

  test('no alias of a `-solid` token is consumed as text, an outline, or a focus-ring color', async () => {
    const files = await sourceFiles();
    const contents = new Map<string, string>();
    const aliases = new Set<string>();
    for (const file of files) {
      const text = await Bun.file(join(root, file)).text();
      contents.set(file, text);
      for (const match of text.matchAll(solidAlias)) {
        const name = match[1];
        if (name !== undefined) aliases.add(name);
      }
    }
    const offenders: string[] = [];
    for (const [file, text] of contents) {
      text.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(foregroundDeclaration)) {
          const name = match[1];
          if (name !== undefined && aliases.has(name)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the alias scan finds an alias reaching a foreground declaration', () => {
    const css = [
      '.a { --x: var(--cinder-status-warning-solid); }',
      '.a:focus-visible { outline-color: var(--x, red); }',
    ].join('\n');
    const names = [...css.matchAll(solidAlias)].map((match) => match[1]);
    expect(names).toEqual(['--x']);
    expect([...css.matchAll(foregroundDeclaration)].map((match) => match[1])).toEqual(['--x']);
  });

  test('the alert, banner, and dropdown rings take status text tokens, not fills', async () => {
    const ring = (property: string, text: string) =>
      [...text.matchAll(new RegExp(`${property}:\\s*var\\(([^)]+)\\)`, 'g'))].map(
        (match) => match[1],
      );
    const alert = await Bun.file(
      join(root, 'components/cinder/src/components/alert/alert.css'),
    ).text();
    expect(ring('--_cinder-alert-ring', alert)).toEqual([
      '--cinder-alert-info',
      '--cinder-status-success-text',
      '--cinder-status-warning-text',
      '--cinder-status-danger-text',
    ]);
    const banner = await Bun.file(
      join(root, 'components/cinder/src/components/banner/banner.css'),
    ).text();
    expect(ring('--_cinder-banner-ring', banner)).toEqual([
      '--cinder-status-info-text',
      '--cinder-status-success-text',
      '--cinder-status-warning-text',
      '--cinder-status-danger-text',
    ]);
    const dropdown = await Bun.file(
      join(root, 'components/cinder/src/components/dropdown/dropdown.css'),
    ).text();
    expect(ring('--_cinder-dropdown-item-ring', dropdown)).toEqual(['--cinder-status-danger-text']);
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
