<script lang="ts">
  import {
    buildAllowAttribute,
    type McpUiHostContext,
  } from '@modelcontextprotocol/ext-apps/app-bridge';
  import { untrack } from 'svelte';
  import { ErrorState, Skeleton } from '@lostgradient/cinder';

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
    fill = false,
    preloadedResource,
    onOpenLink,
    onOpenLinkRefused,
    errorDescription = 'Nothing you did caused it.',
    errorAction,
    onRequestTeardown,
    onError,
    class: className,
  }: McpAppProps = $props();

  // A preloaded page is the first page, so a fill frame draws no loading of its own.
  let resource = $state<McpAppResource | undefined>(
    untrack(() => (fill ? preloadedResource : undefined)),
  );
  let failed = $state(false);
  let loadAttempt = $state(0);
  let frame = $state<HTMLIFrameElement>();
  // The height the app last reported; the frame never exceeds `maxHeight`, even when it shrinks.
  // With `fill` the frame takes its container's height, so the report changes nothing.
  let reportedHeight = $state<number>();
  const height = $derived(
    fill || reportedHeight === undefined ? undefined : Math.min(reportedHeight, maxHeight),
  );
  let bridge: McpAppBridge | undefined;
  let initialized = $state(false);
  // The one `ui/notifications/tool-input` a connection may send, once input is known.
  let toolInputSent = false;
  // The result a connection last sent, so an input-only update does not resend it.
  let sentToolResult: McpAppProps['toolResult'];

  const permissions = $derived(
    resolveMcpAppPermissions(resource?.ui?.permissions, grantedPermissions),
  );
  const allow = $derived(buildAllowAttribute(permissions));
  // The frame remounts when its permissions or its tool-call or open-link capability change,
  // because the app learns each only in its handshake.
  const frameKey = $derived(
    `${allow}|${onToolCall === undefined ? 'no-tools' : 'tools'}|${
      onOpenLink === undefined ? 'no-links' : 'links'
    }`,
  );

  function effectiveHostContext(): McpUiHostContext {
    // The component renders inline only, so the display fields are its own, not the caller's.
    return {
      platform: 'web',
      ...hostContext,
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      // The caller's dimensions stand; only the height cap is the component's, and a filled
      // frame has none.
      containerDimensions: fill
        ? { ...hostContext?.containerDimensions }
        : { ...hostContext?.containerDimensions, maxHeight },
    };
  }

  function report(error: unknown): void {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  // Load the resource whenever the URI or the loader changes.
  $effect(() => {
    const uri = resourceUri;
    const load = loadResource;
    const attempt = loadAttempt;
    // The caller's page is the first one; "Try again" loads afresh.
    const preloaded = fill && attempt === 0 ? preloadedResource : undefined;
    const controller = new AbortController();
    untrack(() => {
      resource = preloaded;
      failed = false;
      reportedHeight = undefined;
    });
    if (preloaded !== undefined) return () => controller.abort();
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
        // Read the current prop on every call too; a refused link is told to the host, with no address.
        onOpenLink:
          onOpenLink === undefined
            ? undefined
            : (path) => (onOpenLink === undefined ? false : onOpenLink(path)),
        onOpenLinkRefused: () => onOpenLinkRefused?.(),
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
    sentToolResult = undefined;
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
      if (result !== undefined && toolInputSent && result !== sentToolResult) {
        sentToolResult = result;
        bridge?.sendToolResult(result).catch(report);
      }
    });
  });

  // Host context changes reach the app only after `ui/notifications/initialized`; until then
  // the handshake's own context stands, and the first run after it sends any difference.
  $effect(() => {
    void hostContext;
    void maxHeight;
    void fill;
    if (!initialized) return;
    untrack(() => bridge?.setHostContext(effectiveHostContext()));
  });
</script>

<div
  class={['mcp-app', className]}
  data-fill={fill ? '' : undefined}
  data-state={failed ? 'error' : resource === undefined ? 'loading' : 'ready'}
>
  {#if failed}
    <!-- One failure form and one retry word wherever the app appears: chat, a run's page and a plugin's page. -->
    <ErrorState
      title={`Couldn’t open ${title}`}
      description={errorDescription}
      headingLevel={fill ? 2 : 3}
      size={fill ? 'default' : 'compact'}
      {...errorAction === undefined ? {} : { secondaryAction: errorAction }}
      onRetry={() => (loadAttempt += 1)}
    />
  {:else if resource !== undefined}
    <!-- A change to the effective permissions or the tool-call capability remounts the frame, so
         the app reinitializes against capabilities that match what the host now offers. -->
    {#key frameKey}
      <iframe
        bind:this={frame}
        class="mcp-app-frame"
        sandbox="allow-scripts"
        srcdoc={buildMcpAppDocument(resource.html, resource.ui?.csp)}
        allow={allow === '' ? undefined : allow}
        {title}
        aria-label={title}
        style:height={height === undefined ? undefined : `${height}px`}
        style:min-height={fill ? undefined : `${Math.min(120, maxHeight)}px`}
      ></iframe>
    {/key}
  {:else}
    <Skeleton variant="card" lines={3} label={`Loading ${title}`} />
  {/if}
</div>

<style>
  .mcp-app {
    width: 100%;
  }

  /* A filled frame takes its container's height: the container sets it, the app scrolls inside. */
  .mcp-app[data-fill] {
    height: 100%;
  }

  .mcp-app-frame {
    display: block;
    width: 100%;
    border: none;
    background: transparent;
  }

  .mcp-app[data-fill] .mcp-app-frame {
    height: 100%;
  }
</style>
