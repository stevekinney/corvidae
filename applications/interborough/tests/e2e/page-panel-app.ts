/**
 * The browser entry of the fixture panels that place a page (`page-panel-plugins.ts`). It is an MCP
 * App written against the ext-apps wire protocol by hand, so it imports nothing: it answers
 * `ui/initialize`, reports a height far above any outlet's so a spec can prove the page fills its
 * outlet instead of following it, and asks the host to open one address inside Interborough and one
 * outside it, saying what the host answered. It is one function call, so that none of its names
 * reaches the global scope the rest of the tests type-check against.
 */
type PanelReply = { error?: unknown; result?: { isError?: boolean } };

(() => {
  const pending = new Map<number, (reply: PanelReply) => void>();
  let nextId = 1;

  function request(method: string, params: Record<string, unknown>): Promise<PanelReply> {
    const id = nextId++;
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise<PanelReply>((resolve) => pending.set(id, resolve));
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const message: unknown = event.data;
    if (typeof message !== 'object' || message === null) return;
    const id: unknown = Reflect.get(message, 'id');
    if (typeof id !== 'number' || Reflect.has(message, 'method')) return;
    pending.get(id)?.(message);
    pending.delete(id);
  });

  document.body.innerHTML = `
    <main style="font-family: sans-serif; padding: 1rem;">
      <h1>Fixture page panel</h1>
      <p>This page is the plugin's own.</p>
      <button id="inside" type="button">Open the run list</button>
      <button id="outside" type="button">Open an outside address</button>
      <p>Answer: <output id="answer">none</output></p>
    </main>
  `;

  async function ask(url: string): Promise<void> {
    const response = await request('ui/open-link', { url });
    const answer = document.getElementById('answer');
    if (answer === null) return;
    answer.textContent =
      response.error !== undefined
        ? 'error'
        : response.result?.isError === true
          ? 'refused'
          : 'opened';
  }

  document.getElementById('inside')?.addEventListener('click', () => void ask('/runs'));
  document
    .getElementById('outside')
    ?.addEventListener('click', () => void ask('https://example.com/outside'));

  void request('ui/initialize', {
    appInfo: { name: 'fixture-page-panel', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  }).then(() => {
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
    parent.postMessage(
      { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 4000 } },
      '*',
    );
  });
})();
