<script lang="ts">
  import { Collapsible } from '@lostgradient/cinder';
</script>

<Collapsible trigger="Shipping details">
  <p>Orders ship within two business days. Tracking is emailed on dispatch.</p>
</Collapsible>

<!-- A Collapsible nested in another's panel (COR-2449), both open so the inner surface shows: flat
     by default (a box inside a box reads as clutter), and beside it the `framed` opt-in. -->
<div
  data-testid="collapsible-nested"
  style="display: grid; gap: var(--cinder-space-6); margin-block-start: var(--cinder-space-6);"
>
  <div data-testid="collapsible-nested-flat">
    <Collapsible trigger="Order 1042" open>
      <p>Two items, shipped on Monday.</p>
      <Collapsible trigger="Tracking events" open>
        <p>Dispatched, then out for delivery.</p>
      </Collapsible>
    </Collapsible>
  </div>
  <div data-testid="collapsible-nested-framed">
    <Collapsible trigger="Order 1042" open>
      <p>Two items, shipped on Monday.</p>
      <Collapsible trigger="Tracking events" open framed>
        <p>Dispatched, then out for delivery.</p>
      </Collapsible>
    </Collapsible>
  </div>
</div>
