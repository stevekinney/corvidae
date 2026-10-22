<script lang="ts">
  import {
    buildAllowAttribute,
    type McpUiHostContext,
  } from '@modelcontextprotocol/ext-apps/app-bridge';
  import { untrack } from 'svelte';

  import { buildMcpAppDocument } from './mcp-app-content-security-policy.ts';
  import {
    createMcpAppBridge,
    resolveMcpAppPermissions,
    type McpAppBridge,
  } from './mcp-app-bridge.ts';
  import type { McpAppProps, McpAppResource } from './mcp-app.types.ts';

  let {
    resourceUri,
    loadResource,
    onToolCall,
    toolInput,
    toolResult,
    hostContext,
    grantedPermissions,
    title = 'MCP App',
    maxHeight = 600,
    onRequestTeardown,
    onError,
    class: className,
  }: McpAppProps = $props();

  let resource = $state<McpAppResource>();
  let failed = $state(false);
  let frame = $state<HTMLIFrameElement>();
  let height = $state<number>();
  let bridge: McpAppBridge | undefined;
  let initialized = false;

  const permissions = $derived(
    resolveMcpAppPermissions(resource?.meta?.permissions, grantedPermissions),
  );
  const allow = $derived(buildAllowAttribute(permissions));

  function effectiveHostContext(): McpUiHostContext {
    return {
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      platform: 'web',
      containerDimensions: { maxHeight },
      ...hostContext,
    };
  }

  function report(error: unknown): void {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  // Load the resource whenever the URI or the loader changes.
  $effect(() => {
    const uri = resourceUri;
    const load = loadResource;
    const controller = new AbortController();
    untrack(() => {
      resource = undefined;
      failed = false;
      height = undefined;
    });
    void (async () => {
      try {
        const loaded = await load(uri, { signal: controller.signal });
        if (!controller.signal.aborted) resource = loaded;
      } catch (error) {
        if (controller.signal.aborted) return;
        failed = true;
        report(error);
      }
    })();
    return () => controller.abort();
  });

  // Connect the bridge, then navigate the iframe. The bridge listens before the document exists,
  // so the app's first message cannot be missed. Closing it removes the window listener.
  $effect(() => {
    const element = frame;
    const loaded = resource;
    if (element === undefined || loaded === undefined) return;
    const frameWindow = element.contentWindow;
    if (frameWindow === null) {
      failed = true;
      report(new Error('The MCP App frame has no window.'));
      return;
    }
    const connection = untrack(() =>
      createMcpAppBridge({
        frameWindow,
        csp: loaded.meta?.csp,
        permissions,
        hostContext: effectiveHostContext(),
        onToolCall,
        onSizeChange: (next) => {
          height = Math.min(next, maxHeight);
        },
        onInitialized: () => {
          initialized = true;
          if (toolInput !== undefined) connection.sendToolInput(toolInput).catch(report);
          if (toolResult !== undefined) connection.sendToolResult(toolResult).catch(report);
        },
        onRequestTeardown: () => onRequestTeardown?.(),
      }),
    );
    bridge = connection;
    let active = true;
    void (async () => {
      try {
        await connection.connect();
        if (active) element.srcdoc = buildMcpAppDocument(loaded.html, loaded.meta?.csp);
      } catch (error) {
        failed = true;
        report(error);
      }
    })();
    return () => {
      active = false;
      initialized = false;
      bridge = undefined;
      connection.close();
    };
  });

  // Forward later changes to a running app.
  $effect(() => {
    const next = toolResult;
    if (next !== undefined && initialized) bridge?.sendToolResult(next).catch(report);
  });

  $effect(() => {
    const next = hostContext;
    void maxHeight;
    if (next !== undefined || initialized) {
      untrack(() => bridge?.setHostContext(effectiveHostContext()));
    }
  });
</script>

<div
  class={['mcp-app', className]}
  data-state={failed ? 'error' : resource === undefined ? 'loading' : 'ready'}
>
  {#if failed}
    <p class="mcp-app-error" role="alert">This app could not be loaded.</p>
  {:else if resource !== undefined}
    <iframe
      bind:this={frame}
      class="mcp-app-frame"
      sandbox="allow-scripts"
      allow={allow === '' ? undefined : allow}
      {title}
      aria-label={title}
      style:height={height === undefined ? undefined : `${height}px`}
    ></iframe>
  {/if}
</div>

<style>
  .mcp-app {
    width: 100%;
  }

  .mcp-app-frame {
    display: block;
    width: 100%;
    min-height: 120px;
    border: none;
    background: transparent;
  }

  .mcp-app-error {
    margin: 0;
    padding: var(--cinder-space-3);
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }
</style>
