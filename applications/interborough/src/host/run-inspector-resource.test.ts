import { describe, expect, it } from 'bun:test';

import { digestOf } from './mcp-app-build.ts';
import {
  buildRunInspectorPage,
  MCP_APP_MIME_TYPE,
  RUN_INSPECTOR_TOOL,
  RUN_INSPECTOR_UI_META,
  RUN_INSPECTOR_URI,
  runInspectorMount,
} from './run-inspector-resource.ts';

describe('the run inspector resource', () => {
  it('is one self-contained document with a deterministic digest', async () => {
    const { html, contentDigest } = await buildRunInspectorPage();
    expect(contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOf(html)).toBe(contentDigest);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it('declares deny-by-default security and links to its tool', async () => {
    const { resources, toolMeta } = await runInspectorMount();
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ uri: RUN_INSPECTOR_URI, mimeType: MCP_APP_MIME_TYPE });
    expect(RUN_INSPECTOR_UI_META.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(RUN_INSPECTOR_UI_META.permissions).toEqual({});
    expect(toolMeta[RUN_INSPECTOR_TOOL]).toMatchObject({ ui: { resourceUri: RUN_INSPECTOR_URI } });
  });
});
