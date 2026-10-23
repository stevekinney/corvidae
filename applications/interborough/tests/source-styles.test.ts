import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedImportedSelectors = [
  '.weft-shell',
  '.weft-dashboard',
  '.weft-workflow-list__header-actions',
  '.weft-workers-route',
  '.weft-reviews-route',
  '.weft-storage-route',
];

test('source styles compile without discarded imports or other CSS warnings', async () => {
  const filename = fileURLToPath(new URL('../src/styles/index.css', import.meta.url));
  const outputDirectory = await mkdtemp(`${tmpdir()}/weft-ui-css-`);
  try {
    const result = await Bun.build({
      entrypoints: [filename],
      outdir: outputDirectory,
      target: 'browser',
      metafile: true,
    });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    const stylesheet = result.outputs.find((output) => output.path.endsWith('.css'));
    expect(stylesheet).toBeDefined();
    if (stylesheet === undefined) throw new Error('Expected Bun to emit a stylesheet.');
    const stylesheetText = await Bun.file(stylesheet.path).text();
    for (const selector of expectedImportedSelectors) {
      expect(stylesheetText).toContain(selector);
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

/**
 * The page canvas and the shell paint the background every route sits on. A
 * stale token name there resolves to nothing, the shell falls back to the
 * browser canvas, and axe measures dark-theme text against white (COR-124).
 */
test('the page canvas and shell paint with tokens Cinder defines', async () => {
  const cinderSource = dirname(Bun.resolveSync('@lostgradient/cinder', import.meta.dir));
  const tokens = await Bun.file(join(cinderSource, 'styles/tokens-base.css')).text();
  const defined = new Set(
    Array.from(tokens.matchAll(/(--cinder-[a-z0-9-]+)\s*:/g), (match) => match[1]),
  );
  const sources = [
    { file: '../src/styles/index.css', selector: 'body' },
    { file: '../src/styles/foundation.css', selector: '.weft-shell' },
  ];
  for (const { file, selector } of sources) {
    const css = await Bun.file(fileURLToPath(new URL(file, import.meta.url))).text();
    const rules = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g');
    const declarations = Array.from(css.matchAll(rules), (match) => match[1] ?? '').join('\n');
    const used = Array.from(
      declarations.matchAll(/(?:background|color)\s*:\s*var\((--cinder-[a-z0-9-]+)\)/g),
      (match) => match[1],
    );
    expect(used.length, `${selector} paints a background and a text color`).toBe(2);
    for (const token of used) {
      expect(defined.has(token ?? ''), `${selector} uses undefined ${token}`).toBe(true);
    }
  }
});

/**
 * A `var(--cinder-…)` that names a token Cinder never defines resolves to
 * nothing: the declaration silently falls back to its initial or inherited
 * value, so a warning band loses its fill or a status edge disappears
 * (COR-124). Every `--cinder-*` name anywhere in Weft's UI CSS, Svelte, and
 * TypeScript source (TypeScript builds inline styles too), comments included,
 * must be one Cinder's token sheet declares. Test files are skipped: they
 * may name an undefined token on purpose.
 */
test('every --cinder-* token in Weft UI source is one Cinder defines', async () => {
  const cinderSource = dirname(Bun.resolveSync('@lostgradient/cinder', import.meta.dir));
  const tokens = await Bun.file(join(cinderSource, 'styles/tokens-base.css')).text();
  const defined = new Set(
    Array.from(tokens.matchAll(/(--cinder-[a-z0-9-]+)\s*:/g), (match) => match[1]),
  );
  const uiSource = fileURLToPath(new URL('../src/', import.meta.url));
  const undefinedReferences: string[] = [];
  for await (const file of new Bun.Glob('**/*.{css,svelte,ts}').scan(uiSource)) {
    if (/\.test(-support|-harness)?\./.test(file)) continue;
    const text = await Bun.file(join(uiSource, file)).text();
    for (const match of text.matchAll(/--cinder-[a-z0-9-]+/g)) {
      if (!defined.has(match[0])) undefinedReferences.push(`${file}: ${match[0]}`);
    }
  }
  expect(undefinedReferences).toEqual([]);
});

/**
 * Interborough looks right on Cinder's defaults (COR-1552). A `--cinder-*` custom property
 * declared anywhere in the app's CSS or Svelte source is a token override, which is exactly what
 * retuning Cinder itself replaced. Reading a token with `var()` is the supported use and is not a
 * declaration, so this matches only a name followed by a colon.
 */
test('no file under src declares a --cinder-* custom property', async () => {
  const uiSource = fileURLToPath(new URL('../src/', import.meta.url));
  const declarations: string[] = [];
  for await (const file of new Bun.Glob('**/*.{css,svelte}').scan(uiSource)) {
    const text = await Bun.file(join(uiSource, file)).text();
    for (const match of text.matchAll(/--cinder-[a-z0-9-]+\s*:/g)) {
      declarations.push(`${file}: ${match[0]}`);
    }
  }
  expect(declarations).toEqual([]);
});

/**
 * Spacing and type come from Cinder's tokens (COR-1647): the 4/8/12/16/24/32/48 spacing scale and
 * the type roles, so no screen invents its own padding or font size. A raw `px` length in a
 * `padding` or `font-size` declaration, in a stylesheet, a Svelte `<style>` block, or an inline
 * `style` attribute, is how every screen drifted off the scale. A `var(--cinder-…, 15px)`
 * fallback counts too: Cinder's stylesheet is always loaded, so the fallback is dead and only
 * hides a missing token. `RAW_PIXEL_ALLOWLIST` names the `file:line` entries that may keep one,
 * and it starts empty: a screen that needs a value the scale lacks asks Cinder for a token.
 */
const RAW_PIXEL_ALLOWLIST: readonly string[] = [];

/** Replaces every comment in `source` with spaces, so the line numbers after it hold. */
function blankComments(source: string): string {
  const blank = (comment: string) => comment.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank);
}

/** The `padding` and `font-size` declarations in `source` that hold a raw `px` length. */
function rawPixelDeclarations(source: string): string[] {
  const text = blankComments(source);
  const found: string[] = [];
  const declaration = /(?<![\w-])(padding(?:-[a-z]+)*|font-size)\s*:\s*([^;{}"'`]*)/g;
  for (const match of text.matchAll(declaration)) {
    if (!/\d(?:\.\d+)?px\b/.test(match[2] ?? '')) continue;
    const line = text.slice(0, match.index).split('\n').length;
    found.push(`${line}: ${match[0].trim()}`);
  }
  return found;
}

test('the raw-pixel detector finds a px length in a padding or font-size and nothing else', () => {
  expect(rawPixelDeclarations('.a { padding: 12px 16px; }')).toHaveLength(1);
  expect(rawPixelDeclarations('.a { padding-inline-start: 18px }')).toHaveLength(1);
  expect(rawPixelDeclarations('.a { font-size: var(--cinder-text-md, 15px); }')).toHaveLength(1);
  expect(rawPixelDeclarations('<div style="color: red; padding: 15px;"></div>')).toHaveLength(1);
  expect(rawPixelDeclarations('.a { padding: 0 var(--cinder-space-4) 0 calc(1px + 2px); }')).toHaveLength(1);
  expect(rawPixelDeclarations('.a { padding: var(--cinder-density-pad-block) 0; }')).toEqual([]);
  expect(
    rawPixelDeclarations('.a { margin: 4px; gap: 8px; width: 36px; border: 1px solid red; }'),
  ).toEqual([]);
  expect(rawPixelDeclarations('/* padding: 10px */ .a { color: red; }')).toEqual([]);
  expect(rawPixelDeclarations('<!-- font-size: 9px -->')).toEqual([]);
});

test('no stylesheet or Svelte source under src sets a raw px padding or font-size', async () => {
  const uiSource = fileURLToPath(new URL('../src/', import.meta.url));
  const violations: string[] = [];
  for await (const file of new Bun.Glob('**/*.{css,svelte}').scan(uiSource)) {
    if (/\.test(-support|-harness)?\./.test(file)) continue;
    const text = await Bun.file(join(uiSource, file)).text();
    for (const found of rawPixelDeclarations(text)) {
      const entry = `${file}:${found}`;
      if (!RAW_PIXEL_ALLOWLIST.some((allowed) => entry.startsWith(allowed))) {
        violations.push(entry);
      }
    }
  }
  expect(violations).toEqual([]);
});
