/**
 * The pending-review app as a `ui://` resource (COR-910, 2 of 2): its URI, the `_meta.ui` it
 * declares, the tool it is linked to, and the build of its page. It adds no Bureau operation: the
 * page lists through `bureau.reviews.list`, which opens it, and decides through the existing
 * `bureau.reviews.get` and `bureau.reviews.resolve`.
 */
import type { OperationMcpResource } from '@lostgradient/weft';

import { buildMcpAppPage, type BuiltMcpApp } from './mcp-app-build.ts';
import { MCP_APP_BASE_STYLES, MCP_APP_MIME_TYPE } from './run-inspector-resource.ts';

const STYLES = `${MCP_APP_BASE_STYLES}
section{border-top:1px solid GrayText;margin-top:1rem}
textarea{font:inherit;width:100%;box-sizing:border-box;display:block;margin:.25rem 0;color:FieldText;background:Field}
label{font-weight:600}
button+button{margin-left:.5rem}
`;

/** The app's resource URI. The version is part of the URI: a changed contract is a new one. */
export const PENDING_REVIEW_URI = 'ui://bureau/pending-review/v1';

/** The tool a host runs to open the app on the caller's pending reviews. */
export const PENDING_REVIEW_TOOL = 'bureau.reviews.list';

/**
 * The app's `_meta.ui`: every origin list empty and every permission absent, which is denied, with
 * no dedicated origin requested.
 */
export const PENDING_REVIEW_UI_META = {
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  permissions: {},
  prefersBorder: false,
};

let built: Promise<BuiltMcpApp> | undefined;

/** Build the app's page once per process. */
export function buildPendingReviewPage(): Promise<BuiltMcpApp> {
  built ??= buildMcpAppPage({
    entry: new URL('../mcp-apps/pending-review/app.ts', import.meta.url).href,
    title: 'Pending reviews',
    styles: STYLES,
  });
  return built;
}

/** The resource and the tool metadata the Bureau MCP adapter mounts for the app. */
export async function pendingReviewMount(): Promise<{
  readonly resources: readonly OperationMcpResource[];
  readonly toolMeta: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}> {
  const { html, contentDigest } = await buildPendingReviewPage();
  return {
    resources: [
      {
        uri: PENDING_REVIEW_URI,
        name: 'pending-review',
        title: 'Pending reviews',
        description: 'The reviews waiting for the caller: approve, deny, or reject with feedback.',
        mimeType: MCP_APP_MIME_TYPE,
        text: html,
        _meta: { ui: PENDING_REVIEW_UI_META, contentDigest },
      },
    ],
    toolMeta: {
      [PENDING_REVIEW_TOOL]: {
        ui: { resourceUri: PENDING_REVIEW_URI, visibility: ['model', 'app'] },
      },
    },
  };
}
