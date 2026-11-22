<script lang="ts">
  import { CodeBlock } from './index.ts';

  // The two blocks Settings › MCP shows, with the endpoints that cut them mid-word: a URL's width
  // moves with its port and its host, and so does the place a browser cut it.
  const endpoints = [
    { name: 'short', url: 'http://127.0.0.1:7405/bureau/mcp' },
    { name: 'port', url: 'http://127.0.0.1:52114/bureau/mcp' },
    { name: 'long-host', url: 'http://interborough-host.local:7405/bureau/mcp' },
  ];

  /**
   * A Shiki-shaped highlighter: one `<span class="line">` per line, each word and each string its
   * own colored token, as the page's highlighter draws the JSON block.
   */
  function highlight(code: string): string {
    const lines = code.split('\n').map((line) => {
      const tokens = line.match(/"[^"]*"|\s+|[^\s"]+/g) ?? [];
      const spans = tokens.map(
        (token) =>
          `<span style="${
            token.startsWith('"')
              ? '--shiki-light:#032f62;--shiki-dark:#9ecbff'
              : '--shiki-light:#24292e;--shiki-dark:#e1e4e8'
          }">${token}</span>`,
      );
      return `<span class="line">${spans.join('')}</span>`;
    });
    return `<pre class="shiki"><code>${lines.join('\n')}</code></pre>`;
  }

  const json = (url: string) =>
    `{\n  "mcpServers": {\n    "interborough": {\n      "type": "http",\n      "url": "${url}"\n    }\n  }\n}`;
</script>

<div class="code-block-breaks">
  {#each endpoints as endpoint (endpoint.name)}
    <div data-testid={`plain-${endpoint.name}`}>
      <CodeBlock
        code={`claude mcp add --transport http interborough ${endpoint.url}`}
        copyable
        wrap
      />
    </div>
    <div data-testid={`highlighted-${endpoint.name}`}>
      <CodeBlock
        code={json(endpoint.url)}
        language="json"
        highlighter={highlight}
        languageLabelVisible={false}
        copyable
        wrap
      />
    </div>
  {/each}
</div>

<style>
  .code-block-breaks {
    display: grid;
    /* One track that may shrink to the viewport, so a block is as wide as the screen leaves it. */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cinder-space-4);
    padding: var(--cinder-space-4);
  }
</style>
