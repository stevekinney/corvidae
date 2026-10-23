/**
 * The run inspector as a `ui://` resource (COR-910): its URI, the `_meta.ui` it declares, the tool
 * it is linked to, and the build of its page.
 */
import type { OperationMcpResource } from '@lostgradient/weft';

import { buildMcpAppPage, type BuiltMcpApp } from './mcp-app-build.ts';

/** The inspector's resource URI. The version is part of the URI: a changed contract is a new one. */
export const RUN_INSPECTOR_URI = 'ui://bureau/run-inspector/v1';

/** The MCP App media type. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** The tool a host runs to open the inspector on a task. */
export const RUN_INSPECTOR_TOOL = 'bureau.tasks.inspect';

/**
 * The inspector's `_meta.ui`: every origin list empty and every permission absent, which is
 * denied. The page reaches no origin, embeds no frame, sets no base URI, and asks for neither
 * camera, microphone, geolocation, nor clipboard. It asks for no dedicated origin either; the host
 * gives it its default sandbox origin.
 */
export const RUN_INSPECTOR_UI_META = {
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  permissions: {},
  prefersBorder: false,
};

/** The styles every MCP App page shares: system colors, visible focus, and no motion on request. */
export const MCP_APP_BASE_STYLES = `
:root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif}
body{margin:0;padding:12px 16px;background:Canvas;color:CanvasText}
h1{font-size:1.1rem;margin:0 0 .5rem}h2{font-size:.95rem;margin:1rem 0 .25rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.15rem .75rem;margin:0}dt{font-weight:600}dd{margin:0}
ul{margin:.25rem 0;padding-left:1.25rem}
button{font:inherit;padding:.35rem .8rem;border:1px solid ButtonText;border-radius:4px;background:ButtonFace;color:ButtonText;cursor:pointer}
button:disabled{opacity:.6;cursor:not-allowed}
button:focus-visible{outline:3px solid Highlight;outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

let built: Promise<BuiltMcpApp> | undefined;

/** Build the inspector page once per process. */
export function buildRunInspectorPage(): Promise<BuiltMcpApp> {
  built ??= buildMcpAppPage({
    entry: new URL('../mcp-apps/run-inspector/app.ts', import.meta.url).href,
    title: 'Run inspector',
    styles: MCP_APP_BASE_STYLES,
  });
  return built;
}

/** The resource and the tool metadata the Bureau MCP adapter mounts for the inspector. */
export async function runInspectorMount(): Promise<{
  readonly resources: readonly OperationMcpResource[];
  readonly toolMeta: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}> {
  const { html, contentDigest } = await buildRunInspectorPage();
  return {
    resources: [
      {
        uri: RUN_INSPECTOR_URI,
        name: 'run-inspector',
        title: 'Run inspector',
        description: 'Liveness, ownership tree, progress, result, and abort for one Bureau task.',
        mimeType: MCP_APP_MIME_TYPE,
        text: html,
        _meta: { ui: RUN_INSPECTOR_UI_META, contentDigest },
      },
    ],
    toolMeta: {
      [RUN_INSPECTOR_TOOL]: {
        ui: { resourceUri: RUN_INSPECTOR_URI, visibility: ['model', 'app'] },
      },
    },
  };
}
