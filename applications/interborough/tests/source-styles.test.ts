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
