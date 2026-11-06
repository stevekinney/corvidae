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

/** A `--cinder-status-*-solid` fill, however it is reached. */
const statusSolidToken = /^--cinder-status-[a-z]+-solid$/;

/** Every declaration the guard judges in a component's own sheet, in source order. */
function declarations(css: string): Array<{ property: string; value: string }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/(?<![\w-])(-{0,2}[\w-]+)\s*:\s*([^;{}]+)[;}]/g)].map(
    (match) => ({ property: match[1] ?? '', value: (match[2] ?? '').trim() }),
  );
}

/** A property that paints something a reader must see: text, an icon, an outline, or a ring. */
function isForegroundProperty(property: string): boolean {
  return (
    property === 'color' ||
    property === 'outline-color' ||
    property === '--cinder-focus-ring-color' ||
    /^--_cinder-[\w-]*-ring$/.test(property)
  );
}

/**
 * The tokens a foreground declaration finally paints with. A `var(--x)` that the same sheet
 * declares as a custom property is followed to what that property holds, any number of aliases
 * deep, so a ring routed through `--_cinder-*-ring`, a fallback, or a `color-mix` still reaches its
 * leaf. A name the sheet never declares is a leaf: a global token, or `currentColor`.
 */
function foregroundLeaves(css: string): { leaves: Set<string>; foregroundCount: number } {
  const all = declarations(css);
  const byName = new Map<string, string[]>();
  for (const { property, value } of all) {
    if (!property.startsWith('--')) continue;
    byName.set(property, [...(byName.get(property) ?? []), value]);
  }
  const leaves = new Set<string>();
  const visited = new Set<string>();
  const follow = (value: string): void => {
    if (/\bcurrentColor\b/i.test(value)) leaves.add('currentColor');
    for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = match[1];
      if (name === undefined) continue;
      const held = byName.get(name);
      if (held === undefined) {
        leaves.add(name);
      } else if (!visited.has(name)) {
        visited.add(name);
        held.forEach(follow);
      }
    }
  };
  const foreground = all.filter(({ property }) => isForegroundProperty(property));
  foreground.forEach(({ value }) => follow(value));
  return { leaves, foregroundCount: foreground.length };
}

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

  test('the alert, banner, and dropdown foregrounds and rings never resolve to a status fill', async () => {
    // The components were redesigned (neutral banner, `--cinder-alert-info`'s own contrast-checked
    // pair), so this pins the guard's purpose, not the old implementation: whatever a ring,
    // outline, focus-ring colour, or `color` finally resolves to, it is never a `-solid` token.
    // The minimum counts keep the scan from passing on a sheet it no longer finds anything in.
    const sheets = [
      ['alert/alert.css', 4],
      ['banner/banner.css', 5],
      ['dropdown/dropdown.css', 3],
    ] as const;
    for (const [sheet, minimum] of sheets) {
      const css = await Bun.file(join(root, 'components/cinder/src/components', sheet)).text();
      const { leaves, foregroundCount } = foregroundLeaves(css);
      expect(foregroundCount).toBeGreaterThanOrEqual(minimum);
      expect([...leaves].filter((leaf) => statusSolidToken.test(leaf))).toEqual([]);
    }
  });

  test('the status rings still resolve to text tokens', async () => {
    const read = (sheet: string) =>
      Bun.file(join(root, 'components/cinder/src/components', sheet)).text();
    const ringLeaves = (css: string, property: RegExp): string[] =>
      declarations(css)
        .filter((declaration) => property.test(declaration.property))
        .flatMap((declaration) => [...declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)])
        .map((match) => match[1] ?? '');
    for (const status of ['success', 'warning', 'danger']) {
      const text = `--cinder-status-${status}-text`;
      expect(ringLeaves(await read('alert/alert.css'), /^--_cinder-alert-ring$/)).toContain(text);
      expect(ringLeaves(await read('banner/banner.css'), /^--_cinder-banner-ring$/)).toContain(
        text,
      );
    }
    expect(ringLeaves(await read('banner/banner.css'), /^--_cinder-banner-ring$/)).toContain(
      '--cinder-status-info-text',
    );
    expect(
      ringLeaves(await read('dropdown/dropdown.css'), /^--_cinder-dropdown-item-ring$/),
    ).toEqual(['--cinder-status-danger-text']);
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

  test('the toast icon and chip text take a foreground, never the stripe fill', async () => {
    // The toast is an inverse chip: its text is `--cinder-text-inverse`, and its icon, spinner and
    // dismiss button inherit that through `currentColor`. A status fill can tint the chip's
    // surface (the danger toast), but it is not a foreground.
    const css = await Bun.file(
      join(root, 'components/cinder/src/components/toast-region/toast-region.css'),
    ).text();
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.[\]'=-]/g, '\\$&');
      const match = css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
      return match?.[1] ?? '';
    };
    expect(rule('.cinder-toast__icon')).toMatch(/(?<![\w-])color:\s*currentColor\s*;/);
    expect(rule('.cinder-toast')).toMatch(/(?<![\w-])color:\s*var\(--cinder-text-inverse\)/);
    expect(css).not.toContain('--_cinder-toast-accent');
    const { leaves, foregroundCount } = foregroundLeaves(css);
    expect(foregroundCount).toBeGreaterThanOrEqual(5);
    expect([...leaves].filter((leaf) => statusSolidToken.test(leaf))).toEqual([]);
  });

  test('hit-target expansions react to any coarse pointer, so hybrid devices get them too', async () => {
    const send = await Bun.file(
      join(root, 'components/chat/src/lib/components/chat/input/chat-input.svelte'),
    ).text();
    expect(send).toMatch(
      /@media \(any-pointer: coarse\) \{\s*\.chat-input-footer :global\(\.cinder-button\) \{\s*min-block-size: var\(--cinder-touch-target-min\)/,
    );
    const toggle = await Bun.file(
      join(root, 'components/cinder/src/components/toggle/toggle.css'),
    ).text();
    expect(toggle).toContain('@media (any-pointer: coarse)');
    expect(toggle).not.toMatch(/@media \(pointer: coarse\)/);
  });
});
