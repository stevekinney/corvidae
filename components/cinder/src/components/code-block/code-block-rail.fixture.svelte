<script lang="ts">
  import { CodeBlock } from './index.ts';

  // The command Settings › MCP shows, so the endpoint's width against a row is the page's own.
  const command = 'claude mcp add --transport http interborough http://127.0.0.1:7439/bureau/mcp';
  // A first word as wide as the endpoint, so the browser's choice between breaking it beside the
  // rail and moving the row below it can be read.
  const longFirstWord = 'http://127.0.0.1:7439/bureau/mcp is the address a client connects to';
  const scrolling = `const settings = { theme: 'light', density: 'comfortable', locale: 'en-GB', timeZone: 'Europe/London' };`;
  const metadataRail = new URLSearchParams(globalThis.location.search).get('metadata-rail') === '1';
  const metadataCode =
    'const metadataRailMustReserveEveryVisibleLabel = response.headers.get("x-correlation-id");';
</script>

<div class="code-block-rail">
  <!-- A floating copy button named by a 40-character label: its tooltip must not widen the block. -->
  <div data-testid="long-label">
    <CodeBlock
      code="claude mcp add"
      copyable
      copyLabel="Copy the Claude Code command for Cursor."
    />
  </div>
  <!-- A scrolling block keeps the rail on every row. -->
  <div data-testid="scrolling">
    <CodeBlock code={scrolling} language="typescript" languageLabelVisible={false} copyable />
  </div>
  <!-- A wrapping block reserves the rail beside the first row only. -->
  <div data-testid="wrapped">
    <CodeBlock code={command} copyable wrap />
  </div>
  <!-- A first word wider than the first row, which gives up the rail, but not than a full row. -->
  <div data-testid="long-first-word">
    <CodeBlock code={longFirstWord} copyable wrap />
  </div>
  {#if metadataRail}
    <!-- The browser rail regression turns these on explicitly, leaving the stable fixture unchanged. -->
    <div data-testid="floating-language">
      <CodeBlock code={metadataCode} language="typescript" copyable copyFloating />
    </div>
    <div data-testid="floating-streaming-status">
      <CodeBlock
        code={metadataCode}
        language="typescript"
        streaming
        streamingLabel="Writing response…"
        copyFloating
      />
    </div>
    <div data-testid="floating-language-wrapped">
      <CodeBlock code={metadataCode} language="typescript" copyable copyFloating wrap />
    </div>
  {/if}
</div>

<style>
  .code-block-rail {
    display: grid;
    /* One track that may shrink to the viewport. An `auto` track is as wide as its widest item's
     * min-content, and the scrolling block's unbroken line is about 900px, so at 320 and 375 the
     * whole fixture was a 911px page and nothing wrapped. */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cinder-space-4);
    padding: var(--cinder-space-4);
  }
</style>
