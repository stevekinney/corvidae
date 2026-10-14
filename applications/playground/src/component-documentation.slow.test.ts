import { describe, expect, it } from 'bun:test';

import { analyzeComponent } from './analyze.ts';
import { validateComponentDocumentationPayload } from './component-documentation-reference.ts';
import {
  buildComponentDocumentation,
  loadPackageManifestForDocumentation,
} from './component-documentation.ts';
import { CHAT_COMPONENT_SOURCE } from './component-sources.ts';
import { discoverComponentDefinitions } from './discover.ts';

/*
 * Slow lane (COR-1499). Analyzing the Chat components with ts-morph builds a program per component,
 * which is more than Bun's 5-second budget on a busy host. Bun times test bodies and `beforeAll`
 * hooks but not module scope, so the analysis runs here, once, in the order the cases would have
 * run it, and the tests assert on the settled payloads. A failed analysis rejects the whole file
 * rather than one test. Every assertion is the one the combined cases made.
 */
const allDefinitions = await discoverComponentDefinitions();
const chatDefinitions = allDefinitions.filter(
  (definition) => definition.source.id === CHAT_COMPONENT_SOURCE.id,
);
const chatPackageManifest = await loadPackageManifestForDocumentation(CHAT_COMPONENT_SOURCE);
const chatPayloads = new Map<string, Awaited<ReturnType<typeof buildComponentDocumentation>>>();
for (const definition of chatDefinitions) {
  const manifest = await analyzeComponent(definition.filePath, {
    importPath: definition.importPath,
  });
  chatPayloads.set(
    definition.name,
    await buildComponentDocumentation(
      definition.name,
      manifest,
      chatPackageManifest,
      CHAT_COMPONENT_SOURCE,
    ),
  );
}

describe('buildComponentDocumentation for the extracted Chat package', () => {
  it('points a README link to its own headings at their README ids', () => {
    const payload = chatPayloads.get('chat');
    expect(payload).toBeDefined();

    expect(payload!.readme.html).toContain('href="#readme-layout-and-sizing"');
    expect(payload!.readme.html).toContain('id="readme-layout-and-sizing"');
    expect(payload!.readme.html).not.toContain('href="#layout-and-sizing"');
  });

  it('builds valid documentation for every extracted Chat component', () => {
    const failures: string[] = [];
    for (const [name, payload] of chatPayloads) {
      const errors = validateComponentDocumentationPayload(payload);
      if (errors.length > 0) failures.push(`${name}: ${errors.join('; ')}`);
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
});
