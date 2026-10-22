<script lang="ts">
  import { McpApp, type McpAppResource, type McpAppToolCallHandler } from '@lostgradient/chat';
  import { untrack } from 'svelte';

  // Count the window `message` listeners the host adds and removes, so the spec can prove that
  // removing the app leaves none behind. Installed before the app mounts. The count is updated
  // untracked, because the host adds its listener from inside one of its own effects.
  let messageListeners = $state(0);
  const addEventListener = window.addEventListener.bind(window);
  const removeEventListener = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    if (type === 'message') untrack(() => (messageListeners += 1));
    addEventListener(type, listener, options as AddEventListenerOptions);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    if (type === 'message') untrack(() => (messageListeners -= 1));
    removeEventListener(type, listener, options as EventListenerOptions);
  }) as typeof window.removeEventListener;

  // A minimal MCP App, written against the ext-apps 2.0.x wire protocol by hand: it initializes,
  // shows the permissions the host granted, tries to reach the network directly, and offers a
  // button that calls a tool through the host.
  const appHtml = `<body>
<h1>Weather app</h1>
<p>Permissions: <output id="permissions">pending</output></p>
<p>Network: <output id="network">pending</output></p>
<p>Tool input: <output id="tool-input">pending</output></p>
<button id="call" type="button">Call get_weather</button>
<p>Tool result: <output id="tool-result">none</output></p>
<script>
  const show = (id, text) => { document.getElementById(id).textContent = text; };
  const pending = new Map();
  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise((resolve) => pending.set(id, resolve));
  }
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && !('method' in message) && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'ui/notifications/tool-input') {
      show('tool-input', JSON.stringify(message.params.arguments));
    }
  });
  request('ui/initialize', {
    appInfo: { name: 'weather-fixture', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  }).then((response) => {
    const permissions = response.result.hostCapabilities.sandbox.permissions;
    show('permissions', JSON.stringify(permissions));
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
  });
  fetch('https://example.com/forecast').then(
    () => show('network', 'reached'),
    () => show('network', 'blocked'),
  );
  document.getElementById('call').addEventListener('click', async () => {
    const response = await request('tools/call', {
      name: 'get_weather',
      arguments: { city: 'Lisbon' },
    });
    show('tool-result', response.result.content[0].text);
  });
</${'script'}>
</body>`;

  const resource: McpAppResource = {
    html: appHtml,
    // The app asks for the camera; the host grants nothing, so the request is denied.
    meta: { permissions: { camera: {} } },
  };

  let mounted = $state(true);
  let toolCalls = $state<string[]>([]);

  const loadResource = async (): Promise<McpAppResource> => resource;
  const onToolCall: McpAppToolCallHandler = async (params) => {
    const city = String(params.arguments?.['city'] ?? '');
    toolCalls = [...toolCalls, `${params.name}(${city})`];
    return { content: [{ type: 'text', text: `Sunny in ${city}` }] };
  };
</script>

<section data-testid="chat-mcp-app-proof">
  <button type="button" data-testid="remove-app" onclick={() => (mounted = false)}>
    Remove app
  </button>
  <p>Message listeners: <output data-testid="message-listeners">{messageListeners}</output></p>
  <p>Host tool calls: <output data-testid="host-tool-calls">{toolCalls.join(', ')}</output></p>
  {#if mounted}
    <McpApp
      resourceUri="ui://weather/view.html"
      {loadResource}
      {onToolCall}
      toolInput={{ arguments: { city: 'Lisbon' } }}
      title="Weather app"
    />
  {/if}
</section>
