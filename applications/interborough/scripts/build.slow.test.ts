import { outcomeOf, rethrow } from '@lostgradient/testing';
import { readProductionGeneration } from '@lostgradient/velveteen/build/publication';
import { afterAll, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishedBrowserBuildDirectory } from '../src/host/build-info.ts';
import { DEV_RELOAD_ROUTE } from '../src/host/dev-reload.ts';
import {
  NATIVE_DOCUMENT_DIRECTORY,
  openPublishedNativeDocuments,
} from '../src/host/native-document-path.ts';
import { type ApplicationBuild, buildApplication, REPOSITORY_ROOT } from './build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-build-slow-'));
const outdir = join(scratch, 'build');
let builtOutput: ApplicationBuild | undefined;
const buildOutcome = await outcomeOf(async () => {
  builtOutput = await buildApplication({ outdir });
});

function sharedBuild(): ApplicationBuild {
  rethrow(buildOutcome);
  if (builtOutput === undefined) throw new Error('the shared build produced nothing');
  return builtOutput;
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GRAMMAR_MODULE = /@shikijs\/langs\/dist\/([^/]+)\.mjs$/;
const THEME_MODULE = /@shikijs\/themes\/dist\/([^/]+)\.mjs$/;
const CURATED_GRAMMARS = [
  'bash',
  'css',
  'diff',
  'html',
  'javascript',
  'json',
  'markdown',
  'postcss',
  'python',
  'shellscript',
  'sql',
  'svelte',
  'typescript',
  'yaml',
];
const CURATED_THEMES = ['github-dark', 'github-light'];

/** The names a metafile's `outputs[*].inputs` keys yield for `pattern`, sorted. */
function emittedModules(metafile: Bun.BuildMetafile, pattern: RegExp): string[] {
  const names = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) {
      const name = pattern.exec(input)?.[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names].toSorted();
}

it('publishes both native graphs and ships only manifest-listed assets', async () => {
  const built = sharedBuild();
  expect(publishedBrowserBuildDirectory(outdir)).toBe(built.directory);
  const ordinary = await readProductionGeneration(join(built.directory, NATIVE_DOCUMENT_DIRECTORY));
  const privateGeneration = await readProductionGeneration(join(built.directory, 'private'));
  expect(ordinary.manifest.routing.routes.some(({ id }) => id === '/settings/mcp')).toBe(true);
  expect(privateGeneration.manifest.routing.routes.some(({ id }) => id === '/reviews')).toBe(true);
  expect(built.files).not.toContain('index.html');
  expect(built.files.some((file) => file.endsWith('.map') || file.includes('metafile'))).toBe(
    false,
  );
  expect(readdirSync(scratch)).toEqual(['build']);
  for (const generation of [ordinary, privateGeneration]) {
    expect(generation.manifest.assets.some(({ url }) => url.endsWith('.js'))).toBe(true);
    expect(generation.manifest.assets.some(({ url }) => url.endsWith('.css'))).toBe(true);
    expect(generation.directory.startsWith(built.directory + '/')).toBe(true);
  }
  const application = await openPublishedNativeDocuments(built.directory);
  try {
    const response = await application.fetch(new Request('http://localhost/settings/mcp'));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(ordinary.manifest.client.url);
    expect(html).not.toContain(DEV_RELOAD_ROUTE);
    const tokens = readFileSync(
      join(REPOSITORY_ROOT, 'components/cinder/src/styles/tokens-base.css'),
      'utf8',
    );
    const token = /^\s*(--[\w-]+)\s*:/m.exec(tokens)?.[1];
    if (token === undefined) throw new Error('tokens-base.css declares no custom property');
    const stylesheets = await Promise.all(
      (ordinary.manifest.routes['/settings/mcp']?.stylesheets ?? []).map(async (url) => {
        expect(html).toContain(url);
        const stylesheet = await application.fetch(new Request('http://localhost' + url));
        return await stylesheet.text();
      }),
    );
    expect(stylesheets.filter((css) => css.includes(token + ':')).length).toBe(1);
    const wasm = ordinary.manifest.assets.find(({ url }) => url.endsWith('.wasm'));
    if (wasm === undefined) throw new Error('Shiki WebAssembly asset was not published');
    const payload = await application.fetch(new Request('http://localhost' + wasm.url));
    expect(payload.headers.get('content-type')).toContain('application/wasm');
    expect(new Uint8Array(await payload.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0, 97, 115, 109]),
    );
  } finally {
    await application.dispose();
  }
});

it('resolves only the curated Shiki grammars and themes in production', () => {
  const { metafile } = sharedBuild();
  expect(emittedModules(metafile, GRAMMAR_MODULE)).toEqual(CURATED_GRAMMARS);
  expect(emittedModules(metafile, THEME_MODULE)).toEqual(CURATED_THEMES);
  expect(
    Object.keys(metafile.inputs).some((input) =>
      input.endsWith('routes/workflows/detail/workflow-detail.css'),
    ),
  ).toBe(true);
});
