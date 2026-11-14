<script lang="ts">
  import { Button } from '../button/index.ts';
  import { Card } from './index.ts';
</script>

<div class="card-footer-fixture">
  <div data-testid="danger">
    <Card tone="danger" title="Delete project">
      <p class="card-footer-fixture__prose">
        Deleting removes every review, setting and automation rule. This cannot be undone.
      </p>
      {#snippet footer()}
        <Button variant="danger" label="Delete project" />
      {/snippet}
    </Card>
  </div>
  <div data-testid="default">
    <Card title="Export">
      <p class="card-footer-fixture__prose">Download every review as a JSON file.</p>
      {#snippet footer()}
        <Button variant="secondary" label="Export" />
      {/snippet}
    </Card>
  </div>
  <div data-testid="muted">
    <Card title="Export" footerTone="muted">
      <p class="card-footer-fixture__prose">Download every review as a JSON file.</p>
      {#snippet footer()}
        <Button variant="secondary" label="Export" />
      {/snippet}
    </Card>
  </div>
</div>

<style>
  .card-footer-fixture {
    display: grid;
    gap: 1.5rem;
    max-inline-size: 32rem;
    padding: 1rem;
  }

  .card-footer-fixture__prose {
    margin: 0;
  }
</style>
