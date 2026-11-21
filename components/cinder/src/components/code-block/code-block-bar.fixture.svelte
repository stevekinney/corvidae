<script lang="ts">
  import { CodeBlock } from './index.ts';

  const code = `function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const message = greet('world');`;
  const wide = `const settings = { theme: 'light', density: 'comfortable', locale: 'en-GB', timeZone: 'Europe/London' };`;
</script>

<div class="code-block-bar">
  <p>Prose before the block, so the block's own surface reads against the page.</p>
  <div data-testid="language-and-copy">
    <CodeBlock {code} language="typescript" copyable />
  </div>
  <div data-testid="copy-only"><CodeBlock {code} copyable /></div>
  <div data-testid="language-only"><CodeBlock {code} language="typescript" /></div>
  <div data-testid="neither"><CodeBlock {code} /></div>
  <!-- A long language label in a narrow column, so the label must give way to Copy. -->
  <div class="code-block-bar__narrow" data-testid="long-language">
    <CodeBlock {code} language="objective-cpp" copyable />
  </div>
  <div data-testid="numbered"><CodeBlock {code} language="typescript" copyable lineNumbers /></div>
  <div data-testid="scrolling"><CodeBlock code={wide} language="typescript" copyable /></div>
  <div data-testid="wrapped"><CodeBlock code={wide} language="typescript" copyable wrap /></div>
  <p>Prose after the block.</p>
</div>

<style>
  .code-block-bar {
    display: grid;
    /* One track that may shrink to the viewport. An `auto` track is as wide as its widest item's
     * min-content, and the scrolling block's unbroken line is about 900px, so at desktop the page
     * grew to 843px and on a phone the copy controls were cut off. */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cinder-space-4);
    max-inline-size: 36rem;
    padding: var(--cinder-space-4);
  }

  .code-block-bar > p {
    margin: 0;
  }

  .code-block-bar__narrow {
    inline-size: 6rem;
  }
</style>
