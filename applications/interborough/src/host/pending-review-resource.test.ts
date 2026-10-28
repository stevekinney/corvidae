import { describe, expect, it } from 'bun:test';

import { digestOf } from './mcp-app-build.ts';
import {
  buildPendingReviewPage,
  PENDING_REVIEW_TOOL,
  PENDING_REVIEW_UI_META,
  PENDING_REVIEW_URI,
  pendingReviewMount,
} from './pending-review-resource.ts';
import { MCP_APP_MIME_TYPE } from './run-inspector-resource.ts';

describe('the pending-review resource', () => {
  it('is one self-contained document with a deterministic digest', async () => {
    const { html, contentDigest } = await buildPendingReviewPage();
    expect(contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOf(html)).toBe(contentDigest);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it('declares deny-by-default security and links to an existing tool', async () => {
    const { resources, toolMeta } = await pendingReviewMount();
    expect(resources).toMatchObject([{ uri: PENDING_REVIEW_URI, mimeType: MCP_APP_MIME_TYPE }]);
    expect(PENDING_REVIEW_UI_META.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(PENDING_REVIEW_UI_META.permissions).toEqual({});
    expect(PENDING_REVIEW_TOOL).toBe('bureau.reviews.list');
    expect(toolMeta[PENDING_REVIEW_TOOL]).toMatchObject({
      ui: { resourceUri: PENDING_REVIEW_URI },
    });
  });
});
