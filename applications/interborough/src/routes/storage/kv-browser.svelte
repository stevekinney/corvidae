<script lang="ts">
  /**
   * KV browser tab (plan §9.6; design `Weft UI.dc.html` STORAGE
   * "stBrowser"): the get/scan/put/delete/batch operation picker plus the
   * active operation's panel. Layout is a CSS grid (`storage.css`) with
   * named areas (`picker`/`form`/`results`) rather than DOM-order flex, so
   * each panel component can render its own `.weft-storage-form` +
   * `.weft-storage-results` pair independent of where the op-picker sits in
   * the tree.
   *
   * The page opens read-only (COR-1658): Get and Scan are there, and Put, Delete, and Batch are not
   * rendered until the person turns on "Allow writes". The switch is off on every load and is never
   * remembered, because the keys here are the engine's own, one click from recovery breaking. The
   * reserved-prefix warning is shown once, beside the switch it is about; each write panel still
   * warns about the one key it is about to touch (`reserved-prefix-callout.svelte`).
   */
  import { Segment, SegmentedControl, Toggle } from '@lostgradient/cinder';
  import type { StorageConnection } from './storage-client.ts';

  import BatchPanel from './batch-panel.svelte';
  import DeletePanel from './delete-panel.svelte';
  import GetPanel from './get-panel.svelte';
  import PutPanel from './put-panel.svelte';
  import ScanPanel from './scan-panel.svelte';

  interface KvBrowserProps {
    client: StorageConnection;
    conditionalBatchSupported: boolean | undefined;
    /** The non-reserved prefixes found in storage, for the Scan panel's picker; none until they are read. */
    knownPrefixes?: readonly string[];
  }

  let { client, conditionalBatchSupported, knownPrefixes = [] }: KvBrowserProps = $props();

  type StorageOperation = 'get' | 'scan' | 'put' | 'delete' | 'batch';

  let operation = $state<StorageOperation>('scan');
  let allowWrites = $state(false);

  const isWrite = (candidate: StorageOperation) =>
    candidate === 'put' || candidate === 'delete' || candidate === 'batch';

  // Turning writes off while a write panel is open leaves the page on the read-only panel it opened
  // on. The panel shown follows the switch at once, and the picker is brought back to it.
  const shown = $derived<StorageOperation>(!allowWrites && isWrite(operation) ? 'scan' : operation);
  $effect(() => {
    if (shown !== operation) operation = shown;
  });
</script>

<div class="weft-storage-panel-layout">
  <div class="weft-storage-op-picker">
    <SegmentedControl
      id="storage-op-picker"
      label="Storage operation"
      labelVisible={false}
      variant="tablist"
      fullWidth
      bind:value={operation}
    >
      <Segment value="get">Get</Segment>
      <Segment value="scan">Scan</Segment>
      {#if allowWrites}
        <Segment value="put">Put</Segment>
        <Segment value="delete">Delete</Segment>
        <Segment value="batch">Batch</Segment>
      {/if}
    </SegmentedControl>

    <div class="weft-storage-writes">
      <Toggle id="storage-allow-writes" label="Allow writes" bind:checked={allowWrites} />
      <p class="weft-storage-writes__warning">
        Keys under Weft-reserved prefixes (<code class="weft-storage-inline-code">wf:</code>,
        <code class="weft-storage-inline-code">state:</code>,
        <code class="weft-storage-inline-code">lease:</code>, and others) are used internally by the
        engine. Writing to or deleting them directly may disrupt recovery.
      </p>
    </div>
  </div>

  {#if shown === 'get'}
    <GetPanel {client} />
  {:else if shown === 'scan'}
    <ScanPanel {client} {knownPrefixes} />
  {:else if shown === 'put'}
    <PutPanel {client} />
  {:else if shown === 'delete'}
    <DeletePanel {client} />
  {:else}
    <BatchPanel {client} conditionalBatchSupported={conditionalBatchSupported ?? false} />
  {/if}
</div>
