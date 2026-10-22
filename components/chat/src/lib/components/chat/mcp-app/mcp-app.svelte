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
  // The height the app last reported; the frame never exceeds `maxHeight`, even when it shrinks.
  let reportedHeight = $state<number>();
  const height = $derived(
    reportedHeight === undefined ? undefined : Math.min(reportedHeight, maxHeight),
  );
  let bridge: McpAppBridge | undefined;
  let initialized = $state(false);
  // The one `ui/notifications/tool-input` a connection may send, once input is known.
  let toolInputSent = false;

  const permissions = $derived(
    resolveMcpAppPermissions(resource?.ui?.permissions, grantedPermissions),
  );
  const allow = $derived(buildAllowAttribute(permissions));

  function effectiveHostContext(): McpUiHostContext {
    // The component renders inline only, so the display fields are its own, not the caller's.
    return {
      platform: 'web',
      ...hostContext,
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      // The caller's dimensions stand; only the height cap is the component's.
      containerDimensions: { ...hostContext?.containerDimensions, maxHeight },
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
      reportedHeight = undefined;
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

  // The frame is inserted with its `srcdoc`, so it loads exactly one document. The bridge is
  // connected when the frame mounts, before that document's scripts run, so the app's first
  // message cannot be missed. Closing it removes the window listener.
  $effect(() => {
    const element = frame;
    const loaded = resource;
    if (element == null || loaded === undefined) return;
    const frameWindow = element.contentWindow;
    if (frameWindow === null) {
      failed = true;
      report(new Error('The MCP App frame has no window.'));
      return;
    }
    const connection = untrack(() =>
      createMcpAppBridge({
        frameWindow,
        csp: loaded.ui?.csp,
        permissions,
        hostContext: effectiveHostContext(),
        // Read the current prop on every call, so a replaced handler takes effect.
        onToolCall:
          onToolCall === undefined
            ? undefined
            : (params, callOptions) => {
                if (onToolCall === undefined) throw new Error('No tool-call handler.');
                return onToolCall(params, callOptions);
              },
        onSizeChange: (next) => {
          reportedHeight = next;
        },
        onInitialized: () => {
          initialized = true;
        },
        onRequestTeardown: () => onRequestTeardown?.(),
      }),
    );
    bridge = connection;
    toolInputSent = false;
    let active = true;
    // The app document is the `srcdoc` this component wrote, under its CSP. A second load means
    // the app navigated its frame to a document without that CSP, so the bridge stops trusting it.
    let documentLoaded = false;
    const onFrameLoad = (): void => {
      if (!documentLoaded) {
        documentLoaded = true;
        return;
      }
      connection.close();
      bridge = undefined;
      initialized = false;
      failed = true;
      report(new Error('The MCP App navigated away from its document.'));
    };
    element.addEventListener('load', onFrameLoad);
    void (async () => {
      try {
        await connection.connect();
      } catch (error) {
        if (!active) return;
        failed = true;
        report(error);
      }
    })();
    return () => {
      active = false;
      element.removeEventListener('load', onFrameLoad);
      initialized = false;
      bridge = undefined;
      connection.close();
    };
  });

  // Tool input, then results, go to an initialized app only; input may arrive after the
  // handshake, and the protocol sends it once, before any result.
  $effect(() => {
    const input = toolInput;
    const result = toolResult;
    if (!initialized) return;
    untrack(() => {
      if (input !== undefined && !toolInputSent) {
        toolInputSent = true;
        bridge?.sendToolInput(input).catch(report);
      }
      if (result !== undefined && toolInputSent) bridge?.sendToolResult(result).catch(report);
    });
  });

  // Host context changes reach the app only after `ui/notifications/initialized`; until then
  // the handshake's own context stands, and the first run after it sends any difference.
  $effect(() => {
    void hostContext;
    void maxHeight;
    if (!initialized) return;
    untrack(() => bridge?.setHostContext(effectiveHostContext()));
  });
</script>

<div
  class={['mcp-app', className]}
  data-state={failed ? 'error' : resource === undefined ? 'loading' : 'ready'}
>
  {#if failed}
    <p class="mcp-app-error" role="alert">This app could not be loaded.</p>
  {:else if resource !== undefined}
    <!-- A change to the effective permissions remounts the frame, so the app reinitializes
         against capabilities that match its `allow` attribute. -->
    {#key allow}
      <iframe
        bind:this={frame}
        class="mcp-app-frame"
        sandbox="allow-scripts"
        srcdoc={buildMcpAppDocument(resource.html, resource.ui?.csp)}
        allow={allow === '' ? undefined : allow}
        {title}
        aria-label={title}
        style:height={height === undefined ? undefined : `${height}px`}
      ></iframe>
    {/key}
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
