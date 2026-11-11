<script lang="ts" module>
  import type { ConversationHistory, ToolResult } from './conversation-model.ts';

  export type ToolResultOverrideFixtureProps = {
    conversation: ConversationHistory;
  };

  type Inventory = { item: string; available: number };

  /**
   * The recipe from the README ("Showing a typed tool result"): a trusted consumer reads one
   * tool's successful, parts-free result and checks its shape, answering `undefined` for anything
   * else so the caller delegates to Chat's own rendering.
   */
  function readInventory(result: ToolResult | undefined): Inventory | undefined {
    if (result === undefined || result.outcome !== 'success') return undefined;
    if (result.parts !== undefined && result.parts.length > 0) return undefined;
    const value = result.content;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const item: unknown = Object.hasOwn(value, 'item') ? Reflect.get(value, 'item') : undefined;
    const available: unknown = Object.hasOwn(value, 'available')
      ? Reflect.get(value, 'available')
      : undefined;
    if (typeof item !== 'string' || item === '') return undefined;
    if (typeof available !== 'number' || !Number.isInteger(available) || available < 0) {
      return undefined;
    }
    return { item, available };
  }
</script>

<script lang="ts">
  import { Badge } from '@lostgradient/cinder';

  import Chat from './chat.svelte';

  let { conversation }: ToolResultOverrideFixtureProps = $props();
</script>

<div style="height: 24rem;">
  <Chat id="tool-result-override-chat" {conversation}>
    {#snippet messagePart(part, renderDefault)}
      {@const inventory =
        part.type === 'tool-call' && part.pair.call.name === 'lookup_inventory'
          ? readInventory(part.pair.result)
          : undefined}
      {#if inventory}
        <Badge>{inventory.item}: {inventory.available} available</Badge>
      {:else}
        {@render renderDefault(part)}
      {/if}
    {/snippet}
  </Chat>
</div>
