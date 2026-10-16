import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeAll, analyzeComponent, getProjectCreationCount } from './analyze.ts';
import { validateComponentDocumentationPayload } from './component-documentation-reference.ts';
import {
  ComponentDocumentationError,
  buildComponentDocumentation,
  loadPackageManifestForDocumentation,
  renderReadmeDocumentation,
  rewriteComponentReadmeLinks,
} from './component-documentation.ts';
import {
  CHAT_COMPONENT_SOURCE,
  CINDER_COMPONENT_SOURCE,
  EDITOR_COMPONENT_SOURCE,
} from './component-sources.ts';
import { discoverComponentDefinitions } from './discover.ts';
import { PUBLISHED_VERSIONS_PATH } from './playground-paths.ts';
import type { ComponentManifest } from './types.ts';

const COMPONENTS_ROOT = CINDER_COMPONENT_SOURCE.componentsRoot;
const BULK_VALIDATION_CHUNK_SIZE = 20;

function componentManifest(componentName: string): Promise<ComponentManifest> {
  return analyzeComponent(join(COMPONENTS_ROOT, componentName, `${componentName}.svelte`));
}

function chunkManifests(
  manifests: readonly ComponentManifest[],
  chunkSize: number,
): ComponentManifest[][] {
  const chunks: ComponentManifest[][] = [];
  for (let index = 0; index < manifests.length; index += chunkSize) {
    chunks.push(manifests.slice(index, index + chunkSize));
  }
  return chunks;
}

/*
 * Analysis is the expensive part of a documentation build. The first component a package
 * analyzes creates that package's ts-morph project, and each component then pays its own type
 * analysis: on a loaded host, the first Chat component took over four seconds and the six
 * together close to three, against Bun's 5-second budget for a test body or a `beforeAll` hook.
 * Module scope is untimed, so every package these tests document is analyzed here, one
 * component after another, and the tests read the results.
 */
const bulkValidationManifests = await analyzeAll(COMPONENTS_ROOT);
const bulkValidationPackageManifest = await loadPackageManifestForDocumentation();

const allDefinitions = await discoverComponentDefinitions();
const chatDefinitions = allDefinitions.filter(
  (definition) => definition.source.id === CHAT_COMPONENT_SOURCE.id,
);
const chatManifests = new Map<string, ComponentManifest>();
for (const definition of chatDefinitions) {
  chatManifests.set(
    definition.name,
    await analyzeComponent(definition.filePath, { importPath: definition.importPath }),
  );
}
const chatPackageManifest = await loadPackageManifestForDocumentation(CHAT_COMPONENT_SOURCE);

function chatManifest(componentName: string): ComponentManifest {
  const manifest = chatManifests.get(componentName);
  if (manifest === undefined) throw new Error(`Chat component ${componentName} was not analyzed`);
  return manifest;
}

/*
 * A test that analyzes a package nothing above warmed creates a new ts-morph project inside its
 * own clock, which is the cost these warmups exist to keep out. Fail it by name, on any host,
 * rather than leave it to time out only when the machine is busy.
 */
const projectsCreatedAtModuleScope = getProjectCreationCount();
afterEach(() => {
  expect(
    getProjectCreationCount(),
    'a test created a ts-morph project; analyze its package at module scope instead',
  ).toBe(projectsCreatedAtModuleScope);
});

describe('buildComponentDocumentation', () => {
  it('returns Button purpose, README HTML, schema, constraints, examples, and raw artifacts', async () => {
    const payload = await buildComponentDocumentation('button', await componentManifest('button'));

    expect(payload.component.id).toBe('button');
    expect(payload.component.purpose).toContain('Primary interactive control');
    // The Overview README drops the leading `# Button` title (the hero shows it)
    // and the generated reference sections (Props table, CSS Variables,
    // Subcomponents) — those render in the page's own dedicated sections — so
    // only the hand-written prose remains.
    expect(payload.readme.html).not.toContain('<h1>Button</h1>');
    expect(payload.readme.html).toContain('<h2 id="readme-usage">Usage</h2>');
    expect(payload.readme.html).not.toContain('<h2>Props</h2>');
    expect(payload.readme.html).not.toContain('>Props</h2>');
    expect(payload.readme.html).toContain('class="shiki');
    expect(payload.readme.hadUnsafeContent).toBe(false);
    expect(payload.schema).toBeDefined();
    expect(payload.constraints).not.toBeNull();
    expect(payload.examples).not.toBeNull();
    expect(payload.rawArtifacts.manifestEntry).toBeDefined();
    expect(payload.rawArtifacts.schema).toBe(payload.schema);
    expect(payload.rawArtifacts.constraints).toBe(payload.constraints);
    expect(payload.rawArtifacts.examples).toBe(payload.examples);
  });

  it('returns corpus-owned component tokens through public variable discovery', async () => {
    const payload = await buildComponentDocumentation(
      'avatar-group',
      await componentManifest('avatar-group'),
    );

    expect(payload.variables).toEqual(['--cinder-avatar-group-overlap']);
    expect(payload.rawArtifacts.variables).toEqual(['--cinder-avatar-group-overlap']);
  });

  it('rewrites component README links to playground component routes', async () => {
    const payload = await buildComponentDocumentation('modal', await componentManifest('modal'));

    expect(payload.readme.html).toContain('href="/page/confirm-dialog" target="_top"');
    expect(payload.readme.html).toContain('href="/page/alert-dialog" target="_top"');
    expect(payload.readme.html).toContain('href="/page/drawer" target="_top"');
    expect(payload.readme.html).toContain('href="/page/sidebar" target="_top"');
    expect(payload.readme.html).toContain('href="/page/popover" target="_top"');
    expect(payload.readme.html).not.toContain('../confirm-dialog/README.md');
  });

  // The README links of the compose-only leaves send the reader to a section of their parent's
  // README (`../table/README.md#usage`). Dropping the fragment landed them at the top of the page.
  it('keeps the README fragment of a component route link, in the README anchor namespace', async () => {
    const payload = await buildComponentDocumentation(
      'table-cell',
      await componentManifest('table-cell'),
    );

    expect(payload.readme.html).toContain('href="/page/table#readme-usage" target="_top"');
    expect(payload.readme.html).not.toContain('href="/page/table#usage"');
    // The leaf's first link names the whole README, and keeps pointing at the page.
    expect(payload.readme.html).toContain('href="/page/table" target="_top"');
  });

  it('gives the README headings the ids those links name', async () => {
    const payload = await buildComponentDocumentation('table', await componentManifest('table'));

    expect(payload.readme.html).toContain('<h2 id="readme-usage">Usage</h2>');
  });

  it('points a README link to its own headings at their README ids', async () => {
    const payload = await buildComponentDocumentation(
      'chat',
      chatManifest('chat'),
      chatPackageManifest,
      CHAT_COMPONENT_SOURCE,
    );

    expect(payload.readme.html).toContain('href="#readme-layout-and-sizing"');
    expect(payload.readme.html).toContain('id="readme-layout-and-sizing"');
    expect(payload.readme.html).not.toContain('href="#layout-and-sizing"');
  });

  it('keeps a component route link without a fragment as it was', () => {
    const html = rewriteComponentReadmeLinks(
      '<a href="../table/README.md">Table</a>',
      'table-cell',
      new Set(['table-cell', 'table']),
    );

    expect(html).toContain('href="/page/table" target="_top"');
    expect(html).not.toContain('#');
  });

  it('keeps the fragment of a README link that falls back to the repository', () => {
    const html = rewriteComponentReadmeLinks(
      '<a href="../../../README.md#component-authoring-checklist">Checklist</a>',
      'citation',
      new Set(['citation']),
    );

    expect(html).toContain('/blob/main/');
    expect(html).toContain('README.md#component-authoring-checklist"');
  });

  // The fragment a link carries has to name a heading the target page really has. A link that
  // keeps its fragment but whose heading has no id is no better than the dropped fragment was.
  it('links every README section reference to a heading that exists on the target page', async () => {
    const packageManifest = await loadPackageManifestForDocumentation();
    const readmePaths = Array.from(
      new Bun.Glob('*/README.md').scanSync({ cwd: COMPONENTS_ROOT, absolute: false }),
    );
    const linkTargets = new Map<string, Set<string>>();
    const referencedFrom = new Map<string, string>();
    for (const readmePath of readmePaths) {
      const componentName = readmePath.split('/')[0] ?? '';
      const markdown = await Bun.file(join(COMPONENTS_ROOT, readmePath)).text();
      if (!/\]\(\.\.\/[a-z0-9-]+\/README\.md#/.test(markdown)) continue;
      const payload = await buildComponentDocumentation(
        componentName,
        await componentManifest(componentName),
        packageManifest,
      );
      for (const [, slug, fragment] of payload.readme.html.matchAll(
        /href="\/page\/([a-z0-9-]+)#([^"]+)"/g,
      )) {
        if (slug === undefined || fragment === undefined) continue;
        linkTargets.set(slug, (linkTargets.get(slug) ?? new Set()).add(fragment));
        referencedFrom.set(`${slug}#${fragment}`, componentName);
      }
    }
    // The premise: the sweep found the section references the leaf READMEs make.
    expect(linkTargets.size).toBeGreaterThan(5);

    const dangling: string[] = [];
    for (const [slug, fragments] of linkTargets) {
      const target = await buildComponentDocumentation(
        slug,
        await componentManifest(slug),
        packageManifest,
      );
      for (const fragment of fragments) {
        if (!target.readme.html.includes(`id="${fragment}"`)) {
          dangling.push(
            `${referencedFrom.get(`${slug}#${fragment}`)} -> /page/${slug}#${fragment}`,
          );
        }
      }
    }
    expect(dangling).toEqual([]);
  }, 60_000);

  it('rewrites non-component README links to GitHub source URLs', async () => {
    const payload = await buildComponentDocumentation(
      'collapsible',
      await componentManifest('collapsible'),
    );

    expect(payload.readme.html).toContain(
      'href="https://github.com/stevekinney/cinder/blob/main/packages/components/src/components/collapsible/collapsible.a11y.md" target="_blank" rel="noopener noreferrer"',
    );
    expect(payload.readme.html).not.toContain('href="./collapsible.a11y.md"');
  });

  it('reloads the package manifest for each documentation build request', async () => {
    const first = await loadPackageManifestForDocumentation();
    const second = await loadPackageManifestForDocumentation();

    expect(second).not.toBe(first);
    expect(second.components.map((component) => component.id)).toEqual(
      first.components.map((component) => component.id),
    );
  });

  describe('documented package version', () => {
    // The version the playground displays is the one its public repository last
    // published, recorded in `published-versions.json`. Corvidae
    // packages carry no `version` of their own and `components.json` files
    // carry a stale or absent copy, so neither is consulted.
    async function lastPublishedVersion(packageName: string): Promise<string> {
      const recorded: unknown = await Bun.file(PUBLISHED_VERSIONS_PATH).json();
      const versions = (recorded as { lastPublishedVersions: Record<string, string | undefined> })
        .lastPublishedVersions;
      const version = versions[packageName];
      if (version === undefined) throw new Error(`${packageName} has no lastPublishedVersion`);
      return version;
    }

    it.each([
      ['Cinder', CINDER_COMPONENT_SOURCE],
      ['Chat', CHAT_COMPONENT_SOURCE],
      ['Editor', EDITOR_COMPONENT_SOURCE],
    ])('documents the last published %s version from the package map', async (_label, source) => {
      const packageManifest = await loadPackageManifestForDocumentation(source);

      expect(packageManifest.package.version).toBe(await lastPublishedVersion(source.packageName));
    });

    it('ignores a version carried by the package components.json', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'playground-documented-version-'));
      try {
        const chatManifest = (await Bun.file(CHAT_COMPONENT_SOURCE.manifestPath).json()) as {
          package: Record<string, unknown>;
        };
        chatManifest.package['version'] = '9.9.9';
        const manifestPath = join(directory, 'components.json');
        await Bun.write(manifestPath, JSON.stringify(chatManifest));

        const packageManifest = await loadPackageManifestForDocumentation({
          ...CHAT_COMPONENT_SOURCE,
          manifestPath,
        });

        expect(packageManifest.package.version).toBe(
          await lastPublishedVersion('@lostgradient/chat'),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('rejects a package the published versions file does not list', async () => {
      const unlisted = {
        ...CINDER_COMPONENT_SOURCE,
        packageName: '@example/not-in-the-published-versions',
      };

      const error = await loadPackageManifestForDocumentation(unlisted).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(ComponentDocumentationError);
      expect((error as ComponentDocumentationError).code).toBe('malformed-components-manifest');
      expect((error as ComponentDocumentationError).message).toContain('published-versions.json');
    });
  });

  it('loads Chat documentation and source links from the extracted package', async () => {
    const payload = await buildComponentDocumentation(
      'chat',
      chatManifest('chat'),
      chatPackageManifest,
      CHAT_COMPONENT_SOURCE,
    );

    expect(payload.component.importSpecifier).toBe('@lostgradient/chat');
    expect(
      rewriteComponentReadmeLinks(
        '<a href="./chat.a11y.md">Accessibility</a>',
        'chat',
        new Set(['chat']),
        CHAT_COMPONENT_SOURCE,
      ),
    ).toContain('github.com/stevekinney/cinder/blob/main/packages/chat/src/lib/components/chat/');
  });

  describe('README links across component packages', () => {
    // READMEs are authored for this repository's layout, so a Chat README reaches a
    // Cinder README as `components/cinder/...` from `components/chat/...`, not as a
    // sibling directory of its own package.
    const chatToCinderCommandMenu =
      '<a href="../../../../../cinder/src/components/command-menu/README.md">CommandMenu</a>';

    it('routes a Chat README link to a Cinder component README to its playground page', () => {
      const html = rewriteComponentReadmeLinks(
        chatToCinderCommandMenu,
        'chat-composer-popover',
        new Set(['chat-composer-popover', 'command-menu']),
        CHAT_COMPONENT_SOURCE,
      );

      expect(html).toContain('href="/page/command-menu" target="_top"');
      expect(html).not.toContain('github.com');
    });

    it('still falls back to GitHub when the linked component has no playground page', () => {
      const html = rewriteComponentReadmeLinks(
        chatToCinderCommandMenu,
        'chat-composer-popover',
        new Set(['chat-composer-popover']),
        CHAT_COMPONENT_SOURCE,
      );

      expect(html).not.toContain('href="/page/command-menu"');
      expect(html).toContain('github.com/stevekinney/cinder/blob/main/');
    });

    it('does not mistake a link to a non-README file in another package for a component page', () => {
      const html = rewriteComponentReadmeLinks(
        '<a href="../../../../../cinder/src/components/command-menu/command-menu.a11y.md">Accessibility</a>',
        'chat-composer-popover',
        new Set(['chat-composer-popover', 'command-menu']),
        CHAT_COMPONENT_SOURCE,
      );

      expect(html).not.toContain('href="/page/command-menu"');
    });
  });

  it('builds valid documentation for every extracted Chat component', async () => {
    const failures: string[] = [];

    for (const definition of chatDefinitions) {
      const payload = await buildComponentDocumentation(
        definition.name,
        chatManifest(definition.name),
        chatPackageManifest,
        CHAT_COMPONENT_SOURCE,
      );
      const errors = validateComponentDocumentationPayload(payload);
      if (errors.length > 0) failures.push(`${definition.name}: ${errors.join('; ')}`);
    }

    expect(chatDefinitions.map((definition) => definition.name)).toEqual([
      'chat',
      'chat-composer-popover',
      'chat-conversation-header',
      'chat-conversation-list',
      'chat-navigation-rail',
      'chat-sub-session',
    ]);
    expect(failures).toEqual([]);
  });

  it('renders generated README tag references without marking the README unsafe', () => {
    const readme = renderReadmeDocumentation(`
# Generated References

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| ---- | ---- | -------- | ------- | ----------- |
| \`class\` | \`string\` | no | - | Optional extra class on the underlying <Modal>. |
| \`description\` | \`string\` | no | - | Rendered as a single <p> and wired to aria-describedby. |
| \`dangerousTagMention\` | \`string\` | no | - | Mentions <script>, <style>, and <img src="avatar.png"> as literal text. |

<!-- generated:props:end -->
`);

    expect(readme.hadUnsafeContent).toBe(false);
    // The tag-like text must stay ESCAPED. `<` can serialize as the named
    // reference (`&lt;`) or as a numeric reference in hex (`&#x3C;`/`&#x3c;`) or
    // decimal (`&#60;`); which spelling the rehype serializer emits depends on
    // which variant of `decode-named-character-reference` the test environment
    // resolves (the `browser` export condition routes to a DOM-based decoder).
    // Accept any of them — the contract is "escaped, never raw".
    const escapedLessThan = /(?:&lt;|&#x3c;|&#60;)/i;
    const escapedTag = (tag: string) => new RegExp(`${escapedLessThan.source}${tag}>`, 'i');
    expect(readme.html).toMatch(escapedTag('Modal'));
    expect(readme.html).toMatch(escapedTag('p'));
    expect(readme.html).toMatch(escapedTag('script'));
    expect(readme.html).toMatch(escapedTag('style'));
    expect(readme.html).not.toContain('<Modal>');
    expect(readme.html).not.toContain('<script>');
    expect(readme.html).not.toContain('<style>');
    expect(readme.html).not.toContain('<img');
  });

  it('omits contributor-only authoring guidance from the public overview', () => {
    const readme = renderReadmeDocumentation(`
# Example

<!-- generated:a11y-record:required -->

Consumer-facing introduction.

## Authoring checklist

<!-- generated:authoring:start -->
Before publishing this component, complete the internal authoring pre-flight.
<!-- generated:authoring:end -->

## Usage

Consumer-facing usage.
`);

    expect(readme.html).toContain('Consumer-facing introduction.');
    expect(readme.html).toContain('Consumer-facing usage.');
    expect(readme.hadUnsafeContent).toBe(false);
    expect(readme.rawMarkdown).not.toContain('generated:a11y-record:required');
    expect(readme.html).not.toContain('Authoring checklist');
    expect(readme.html).not.toContain('internal authoring pre-flight');
  });

  it('marks unsafe README rendering and validation fails on it', async () => {
    const payload = await buildComponentDocumentation('button', await componentManifest('button'));
    const unsafeReadme = renderReadmeDocumentation('<script>alert("unsafe")</script>');

    expect(unsafeReadme.hadUnsafeContent).toBe(true);
    expect(
      validateComponentDocumentationPayload({
        ...payload,
        readme: unsafeReadme,
      }),
    ).toContain('button README rendering stripped unsafe content');
  });
});

describe('every component documentation payload passes validation', () => {
  // The static-export deploy fetches /api/documentation/:name for every
  // component and aborts the build on any non-2xx response. That route builds
  // the same payload below and 500s when validateComponentDocumentationPayload
  // returns errors — most easily tripped by a raw HTML tag in README prose
  // (e.g. `<table>` instead of `` `<table>` ``), which the markdown sanitizer
  // strips and flags as hadUnsafeContent. Sweeping every component here catches
  // that at unit-test time (a gating job) instead of post-merge on Vercel.
  it('finds component manifests to validate', () => {
    expect(bulkValidationManifests.length).toBeGreaterThan(0);
  });

  for (const [chunkIndex, chunk] of chunkManifests(
    bulkValidationManifests,
    BULK_VALIDATION_CHUNK_SIZE,
  ).entries()) {
    const start = chunkIndex * BULK_VALIDATION_CHUNK_SIZE + 1;
    const end = start + chunk.length - 1;
    it(`builds and validates component doc payloads ${start}-${end}`, async () => {
      const failures: string[] = [];
      for (const manifest of chunk) {
        const payload = await buildComponentDocumentation(
          manifest.kebabName,
          manifest,
          bulkValidationPackageManifest,
        );
        const errors = validateComponentDocumentationPayload(payload);
        if (errors.length > 0) {
          failures.push(`${manifest.kebabName}: ${errors.join('; ')}`);
        }
      }

      expect(failures).toEqual([]);
    });
  }
});
