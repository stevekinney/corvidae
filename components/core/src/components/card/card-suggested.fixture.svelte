<script lang="ts">
  import { Card } from '@lostgradient/card/components/card/index.ts';
</script>

<div class="card-suggested-fixture">
  <div data-testid="titled-suggested">
    <Card title="Call the landlord" tone="suggested">
      <p class="card-suggested-fixture__prose">Ask about the lease renewal before Friday.</p>
    </Card>
  </div>
  <div data-testid="titled-plain">
    <Card title="Call the landlord">
      <p class="card-suggested-fixture__prose">Ask about the lease renewal before Friday.</p>
    </Card>
  </div>
  <div data-testid="untitled-suggested">
    <Card tone="suggested">
      <p class="card-suggested-fixture__prose">Ask about the lease renewal before Friday.</p>
    </Card>
  </div>
  <div data-testid="untitled-plain">
    <Card>
      <p class="card-suggested-fixture__prose">Ask about the lease renewal before Friday.</p>
    </Card>
  </div>
</div>

<style>
  .card-suggested-fixture {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-inline-size: 28rem;
  }

  .card-suggested-fixture__prose {
    margin: 0;
  }
</style>
