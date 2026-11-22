<script lang="ts">
  import { Collapsible } from '@lostgradient/cinder';
</script>

<Collapsible trigger="Shipping details">
  <p>Orders ship within two business days. Tracking is emailed on dispatch.</p>
</Collapsible>

<!-- A Collapsible nested in another's panel (COR-2449), both open so the inner surface shows: flat
     by default (a box inside a box reads as clutter), and beside it the `framed` opt-in. -->
<div data-testid="collapsible-nested" class="collapsible-nested-layout gap-6 margin-block-start-6">
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

<!-- COR-2634: a Collapsible's state and variant styles belong to it alone. Each nested case differs
     from its holder in one attribute, and each reference is a top-level Collapsible with the values
     the nested one should show. -->
<div class="collapsible-nested-layout gap-6 margin-block-start-6">
  <div data-testid="collapsible-nested-closed">
    <Collapsible trigger="Order 1043" open>
      <Collapsible trigger="Tracking events">
        <p>Dispatched, then out for delivery.</p>
      </Collapsible>
    </Collapsible>
  </div>
  <div data-testid="collapsible-nested-disabled-outer">
    <Collapsible trigger="Order 1044" open disabled>
      <Collapsible trigger="Tracking events">
        <p>Dispatched, then out for delivery.</p>
      </Collapsible>
    </Collapsible>
  </div>
  <div data-testid="collapsible-nested-start">
    <Collapsible trigger="Order 1045" open chevron="start">
      <Collapsible trigger="Tracking events" chevron="start">
        <p>Dispatched, then out for delivery.</p>
      </Collapsible>
    </Collapsible>
  </div>
  <div data-testid="collapsible-nested-framed-closed">
    <Collapsible trigger="Order 1046" open>
      <Collapsible trigger="Tracking events" framed>
        <p>Dispatched, then out for delivery.</p>
      </Collapsible>
    </Collapsible>
  </div>
  <div data-testid="collapsible-nested-framed-in-flat">
    <Collapsible trigger="Order 1047" open variant="flat">
      <Collapsible trigger="Tracking events" open framed>
        <p>Dispatched, then out for delivery.</p>
      </Collapsible>
    </Collapsible>
  </div>
  <Collapsible data-testid="collapsible-reference-flat-closed" trigger="Returns" variant="flat">
    <p>Returns are accepted within thirty days.</p>
  </Collapsible>
  <Collapsible data-testid="collapsible-reference-flat-open" trigger="Returns" variant="flat" open>
    <p>Returns are accepted within thirty days.</p>
  </Collapsible>
  <Collapsible
    data-testid="collapsible-reference-flat-start-closed"
    trigger="Returns"
    variant="flat"
    chevron="start"
  >
    <p>Returns are accepted within thirty days.</p>
  </Collapsible>
  <Collapsible data-testid="collapsible-reference-default-closed" trigger="Returns">
    <p>Returns are accepted within thirty days.</p>
  </Collapsible>
  <Collapsible data-testid="collapsible-reference-default-open" trigger="Returns" open>
    <p>Returns are accepted within thirty days.</p>
  </Collapsible>
</div>

<style>
  .collapsible-nested-layout {
    display: grid;
  }
</style>
