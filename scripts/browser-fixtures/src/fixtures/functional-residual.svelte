<script lang="ts">
  import { CodeBlock, Feed, Tree } from '@corvidae/cinder';

  type ReorderTarget = { id: string; position: 'before' | 'after' | 'child' };
  const treeItems = [
    { id: 'alpha', label: 'Alpha' },
    { id: 'beta', label: 'Beta', branch: true },
    { id: 'gamma', label: 'Gamma' },
    { id: 'delta', label: 'Delta' },
    { id: 'epsilon', label: 'Epsilon' },
    { id: 'zeta', label: 'Zeta' },
  ];
  let lastDrop = $state('none');
  const code = `SELECT id, name, created_at, email_address, account_status, last_seen_at, billing_plan, feature_flags
FROM users
WHERE active = true
ORDER BY created_at DESC
LIMIT 10;`;
  const highlightedHtml = `<pre class="shiki" style="background-color:#fff;color:#24292e"><code>${code}</code></pre>`;
  type LayoutHighlighterWindow = Window & {
    cinderCodeBlockLayoutHighlighterReady?: boolean;
    resolveCinderCodeBlockLayoutHighlight?: () => void;
  };
  if (typeof window !== 'undefined') {
    const target = window as LayoutHighlighterWindow;
    target.cinderCodeBlockLayoutHighlighterReady = false;
  }
  function highlighter(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined') {
        reject(new Error('CodeBlock highlighter requires a browser.'));
        return;
      }
      const target = window as LayoutHighlighterWindow;
      target.resolveCinderCodeBlockLayoutHighlight = () => resolve(highlightedHtml);
      target.cinderCodeBlockLayoutHighlighterReady = true;
    });
  }
  function handleReorder(draggedId: string, target: ReorderTarget): void {
    lastDrop = `${draggedId}:${target.position}:${target.id}`;
  }
</script>

<main class="functional-residual-fixture">
  <section aria-label="Feed log">
    <Feed kind="log" label="Deployment events" connectionState="connected">
      <Feed.Event variant="minimal" datetime="2026-05-12T14:30:00Z" timestamp="14:30:00" tone="info"
        >Pipeline started</Feed.Event
      >
      <Feed.Event
        variant="minimal"
        datetime="2026-05-12T14:31:12Z"
        timestamp="14:31:12"
        tone="success">Build published</Feed.Event
      >
      <Feed.Event
        variant="minimal"
        datetime="2026-05-12T14:33:40Z"
        timestamp="14:33:40"
        tone="warning">Canary delayed</Feed.Event
      >
    </Feed>
  </section>

  <section id="example-mount-reorder" aria-label="Tree reorder">
    <Tree
      aria-label="Reorder files"
      onReorder={handleReorder}
      style="max-block-size: 7rem; overflow: auto; border: 1px solid var(--cinder-border); border-radius: var(--cinder-radius-md);"
    >
      {#each treeItems as item (item.id)}
        <Tree.Item
          id={item.id}
          label={item.label}
          branch={item.branch ?? false}
          reorderHandleVisible
        />
      {/each}
    </Tree>
    <p data-testid="last-drop">{lastDrop}</p>
  </section>

  <section id="example-mount-delayed-highlighting" aria-label="Code block">
    <CodeBlock {code} language="sql" {highlighter} />
  </section>
</main>

<style>
  .functional-residual-fixture {
    display: grid;
    gap: 1rem;
    max-inline-size: 48rem;
    margin-inline: auto;
  }
  section {
    min-inline-size: 0;
  }
</style>
