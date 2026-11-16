<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Data cell within a table-row that renders one column value with configurable horizontal alignment.
   * @tag table
   * @tag cell
   * @useWhen Rendering a single value inside a body row of a table.
   * @useWhen Aligning numeric or trailing-action columns via the align prop.
   * @avoidWhen Rendering a column header — use table-header-cell instead.
   * @related table-row, table-header-cell
   */
  export type { TableCellProps } from './table-cell.types.ts';
</script>

<script lang="ts">
  import type { Attachment } from 'svelte/attachments';

  import { tryGetTableContext } from '../table/table.context.ts';
  import type { TableCellProps } from './table-cell.types.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import FullTextTooltip from '../../_internal/full-text-tooltip.svelte';

  let {
    align = 'left',
    as = 'td',
    truncate = false,
    controls = false,
    detail,
    title,
    class: className,
    children,
    ...rest
  }: TableCellProps = $props();

  // A cell with a control tells its table, which stacks its rows only while one is mounted.
  const tableContext = tryGetTableContext();
  $effect(() => {
    if (!controls) return;
    return tableContext?.registerControls?.();
  });

  // A truncating cell shows the full text on hover. Unless the caller supplied
  // a `title`, read it from the rendered text so a snippet child needs no
  // second copy of its own string. The attachment keeps it current when the
  // cell's content changes.
  let renderedText = $state<string | undefined>();

  // The cut text is focusable and opens a tooltip with the whole text, so a keyboard or touch user
  // reaches it too, in a row as well as in a link inside the cell.
  let textElement = $state<HTMLElement | null>(null);
  const holdTextElement: Attachment<HTMLElement> = (element) => {
    textElement = element;
    return () => {
      if (textElement === element) textElement = null;
    };
  };

  const readRenderedText: Attachment<HTMLElement> = (element) => {
    const read = (): void => {
      const text = element.textContent?.trim();
      renderedText = text === undefined || text === '' ? undefined : text;
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  };
</script>

<!-- The detail follows the content with no whitespace between them, so the cell's text has no stray space. -->
<svelte:element
  this={as}
  {...rest}
  title={truncate ? undefined : title}
  scope={as === 'th' ? 'row' : undefined}
  class={classNames('cinder-table__cell', className)}
  data-cinder-align={align}
  data-cinder-truncate={truncate || undefined}
  data-cinder-controls={controls === 'fit' ? 'fit' : controls ? '' : undefined}
>
  {#if truncate}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- the text is cut, so focusing it opens the tooltip with the whole text. -->
    <span
      class="cinder-table__cell-text"
      tabindex="0"
      {@attach readRenderedText}
      {@attach holdTextElement}
    >
      {@render children?.()}
    </span><FullTextTooltip text={title ?? renderedText ?? ''} triggerRef={textElement} />
  {:else}
    {@render children?.()}
  {/if}{#if detail}<span class="cinder-table__cell-detail">{@render detail()}</span>{/if}
</svelte:element>
