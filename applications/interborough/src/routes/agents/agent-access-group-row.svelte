<script lang="ts">
  /**
   * The header row of one group of the Access tab's table (rows 38m, 38q): a button across the
   * row that shows or hides the group's rows, with the group's name and, after it in muted words,
   * its count ("Built in" then "3 of 6 tools allowed"). Two parts, never one string with a
   * separator glyph between them.
   */
  import { Table } from '@lostgradient/cinder';
  import { ChevronDown, ChevronRight } from '@lucide/svelte';

  interface Props {
    /** The group's key, as `data-group`. */
    group: string;
    /** The group's name. */
    label: string;
    /** What follows the name, muted. */
    count: string;
    /** Whether the group's rows are hidden. */
    collapsed: boolean;
    /** Shows or hides the group's rows. */
    onToggle: () => void;
  }

  let { group, label, count, collapsed, onToggle }: Props = $props();
</script>

<Table.Row class="ib-access-group" data-group={group}>
  <Table.Cell colspan={5}>
    <button
      type="button"
      class="ib-access-group__toggle"
      aria-expanded={!collapsed}
      onclick={onToggle}
    >
      {#if collapsed}
        <ChevronRight aria-hidden="true" size={14} />
      {:else}
        <ChevronDown aria-hidden="true" size={14} />
      {/if}
      <span class="ib-access-group__label">{label}</span>
      <span class="ib-access-group__count">{count}</span>
    </button>
  </Table.Cell>
</Table.Row>
