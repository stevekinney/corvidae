<script lang="ts">
  import CopyableValue from './copyable-value.svelte';
</script>

<!-- The two addresses Settings shows. The browser test narrows each paragraph to measure where its
     address breaks. -->
<div class="copyable-value-addresses">
  <p data-testid="a2a">
    <CopyableValue
      data-testid="a2a-value"
      value="http://127.0.0.1:7433/.well-known/agent-card.json"
      label="Copy the address"
    />
  </p>
  <p data-testid="mcp">
    <CopyableValue
      data-testid="mcp-value"
      value="http://127.0.0.1:7234/bureau/mcp"
      label="Copy the address"
    />
  </p>
  <!-- The line Settings › API reference opens with: words, then an address that fits a row. -->
  <p data-testid="lead">
    The API is at
    <CopyableValue
      data-testid="lead-value"
      value="http://127.0.0.1:7399/api"
      label="Copy the address"
    />
  </p>
  <!-- A real host path is longer than a phone sheet. Its Copy target must stay reachable after the
       full value has wrapped, rather than hanging past the sheet's inline end. -->
  <p data-testid="storage-location">
    <CopyableValue
      data-testid="storage-location-value"
      value="/var/folders/ys/8qylcrld5lxcm3bj6nznfh900000gn/T/interborough-storage-showcase-Uo0Fa2/showcase-home"
      label="Copy storage location"
    />
  </p>
</div>

<style>
  .copyable-value-addresses {
    display: grid;
    gap: var(--cinder-space-4);
    padding: var(--cinder-space-4);
  }

  .copyable-value-addresses p {
    margin: 0;
  }
</style>
