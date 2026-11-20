<script lang="ts">
  /**
   * One of a tool's three badges: what it may do, when it asks by default, and where it comes from.
   * The list row and the tool's page draw the same words in the same muted chip, each with its
   * glyph, so the three share one height and one baseline wherever they sit. On the page each chip
   * is focusable and carries a tooltip; in a row, which is itself the control, it is a plain label.
   */
  import { Chip, Tooltip } from '@lostgradient/cinder';
  import { Eye, Hand, Package, Pencil, Shield } from '@lucide/svelte';

  import {
    asksLabel,
    asksTooltip,
    riskLabel,
    riskTooltip,
    tierOf,
    toolSourceChip,
    toolSourceTooltip,
    type ShownTool,
  } from './capability-presentation.ts';

  interface Props {
    /** Which badge. */
    kind: 'risk' | 'asks' | 'source';
    /** The tool it describes. */
    tool: ShownTool;
    /** The names people call the saved sources, so the source badge says "From GitHub". */
    sourceNames?: ReadonlyMap<string, string> | undefined;
    /** Focusable, with a tooltip that says what the badge means: the tool's page, not a list row. */
    explained?: boolean;
    /** The test identifier of the chip, when the chip itself is what a test reads. */
    testId?: string | undefined;
  }

  let { kind, tool, sourceNames, explained = false, testId }: Props = $props();

  const tier = $derived(tierOf(tool));
  const label = $derived(
    kind === 'risk'
      ? riskLabel(tier)
      : kind === 'asks'
        ? asksLabel(tool)
        : toolSourceChip(tool, sourceNames),
  );
  const tooltip = $derived(
    kind === 'risk'
      ? riskTooltip(tier)
      : kind === 'asks'
        ? asksTooltip(tool)
        : toolSourceTooltip(tool),
  );
  /** An eye for a read, a pencil for a change, a shield for danger, a hand for asking, a box for where it is from. */
  const Icon = $derived(
    kind === 'asks'
      ? Hand
      : kind === 'source'
        ? Package
        : tier === 'read-only'
          ? Eye
          : tier === 'dangerous'
            ? Shield
            : Pencil,
  );
</script>

{#snippet chip()}
  <Chip size="sm" tabindex={explained ? 0 : undefined} {label} data-testid={testId}>
    {#snippet leadingIcon()}<Icon size={12} aria-hidden="true" />{/snippet}
  </Chip>
{/snippet}

{#if explained}
  <!-- A flex wrapper, so the chip is a box in it rather than text on a line that its glyph sets. -->
  <Tooltip text={tooltip} class="ib-tool-badge">{@render chip()}</Tooltip>
{:else}
  {@render chip()}
{/if}
