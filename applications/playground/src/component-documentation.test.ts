import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeAll, analyzeComponent } from './analyze.ts';
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
import { REPOSITORY_ROOT } from './playground-paths.ts';
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

const bulkValidationManifests = await analyzeAll(COMPONENTS_ROOT);
const bulkValidationPackageManifest = await loadPackageManifestForDocumentation();

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
    expect(payload.readme.html).toContain('<h2>Usage</h2>');
    expect(payload.readme.html).not.toContain('<h2>Props</h2>');
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

  it('drops README fragments from component route links because page anchors differ', async () => {
    const payload = await buildComponentDocumentation(
      'table-cell',
      await componentManifest('table-cell'),
    );

    expect(payload.readme.html).toContain('href="/page/table" target="_top"');
    expect(payload.readme.html).not.toContain('href="/page/table#usage"');
  });

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
    // The version the playground displays is the one the public mirror last
    // published, recorded in `scripts/mirror/package-map.json`. Corvidae
    // packages carry no `version` of their own and `components.json` files
    // carry a stale or absent copy, so neither is consulted.
    async function lastPublishedVersion(packageName: string): Promise<string> {
      const packageMap: unknown = await Bun.file(
        join(REPOSITORY_ROOT, 'scripts', 'mirror', 'package-map.json'),
      ).json();
      const workspaces = (
        packageMap as { workspaces: Record<string, { lastPublishedVersion?: string }> }
      ).workspaces;
      const version = workspaces[packageName]?.lastPublishedVersion;
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

    it('rejects a package the package map does not list', async () => {
      const unlisted = {
        ...CINDER_COMPONENT_SOURCE,
        packageName: '@example/not-in-the-package-map',
      };

      const error = await loadPackageManifestForDocumentation(unlisted).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(ComponentDocumentationError);
      expect((error as ComponentDocumentationError).code).toBe('malformed-components-manifest');
      expect((error as ComponentDocumentationError).message).toContain('package-map.json');
    });
  });

  it('loads Chat documentation and source links from the extracted package', async () => {
    const manifest = await analyzeComponent(
      join(CHAT_COMPONENT_SOURCE.componentsRoot, 'chat', 'chat.svelte'),
      { importPath: '@lostgradient/chat' },
    );
    const packageManifest = await loadPackageManifestForDocumentation(CHAT_COMPONENT_SOURCE);
    const payload = await buildComponentDocumentation(
      'chat',
      manifest,
      packageManifest,
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

  it('builds valid documentation for every extracted Chat component', async () => {
    const allDefinitions = await discoverComponentDefinitions();
    const definitions = allDefinitions.filter(
      (definition) => definition.source.id === CHAT_COMPONENT_SOURCE.id,
    );
    const packageManifest = await loadPackageManifestForDocumentation(CHAT_COMPONENT_SOURCE);
    const failures: string[] = [];

    for (const definition of definitions) {
      const manifest = await analyzeComponent(definition.filePath, {
        importPath: definition.importPath,
      });
      const payload = await buildComponentDocumentation(
        definition.name,
        manifest,
        packageManifest,
        CHAT_COMPONENT_SOURCE,
      );
      const errors = validateComponentDocumentationPayload(payload);
      if (errors.length > 0) failures.push(`${definition.name}: ${errors.join('; ')}`);
    }

    expect(definitions.map((definition) => definition.name)).toEqual([
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
