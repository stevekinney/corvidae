<script lang="ts">
  import { McpApp, type McpAppResource } from '@lostgradient/chat';

  // An app that reports a height far above its container's, and asks to open one link inside the
  // application and one outside it, so the spec can prove `fill` ignores the report and that
  // `onOpenLink` admits only the first. Written against the ext-apps 2.0.x wire protocol by hand.
  const appHtml = `<body style="margin:0">
<h1>Fill app</h1>
<button id="inside" type="button">Open inside</button>
<button id="outside" type="button">Open outside</button>
<p>Answer: <output id="answer">none</output></p>
<script>
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
    }
  });
  request('ui/initialize', {
    appInfo: { name: 'fill-fixture', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  }).then(() => {
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 3000 } }, '*');
  });
  async function open(url) {
    const response = await request('ui/open-link', { url });
    document.getElementById('answer').textContent = response.error ? 'error' : response.result.isError ? 'refused' : 'opened';
  }
  document.getElementById('inside').addEventListener('click', () => open('/runs/abc?tab=steps'));
  document.getElementById('outside').addEventListener('click', () => open('https://example.com/runs/abc'));
</${'script'}>
</body>`;

  const resource: McpAppResource = { html: appHtml };
  const loadResource = async (): Promise<McpAppResource> => resource;

  let opened = $state<string[]>([]);
  let refused = $state(0);
</script>

<section data-testid="chat-mcp-app-fill-proof">
  <p>Opened links: <output data-testid="opened-links">{opened.join(', ')}</output></p>
  <p>Refused links: <output data-testid="refused-links">{refused}</output></p>
  <div data-testid="fill-container" style="height: 800px;">
    <McpApp
      resourceUri="ui://fill/view.html"
      {loadResource}
      fill
      title="Fill app"
      onOpenLink={(path) => {
        opened = [...opened, path];
        return true;
      }}
      onOpenLinkRefused={() => (refused += 1)}
    />
  </div>
</section>
