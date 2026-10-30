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

  import type { TableCellProps } from './table-cell.types.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    align = 'left',
    as = 'td',
    truncate = false,
    controls = false,
    title,
    class: className,
    children,
    ...rest
  }: TableCellProps = $props();

  // A truncating cell shows the full text on hover. Unless the caller supplied
  // a `title`, read it from the rendered text so a snippet child needs no
  // second copy of its own string. The attachment keeps it current when the
  // cell's content changes.
  let renderedText = $state<string | undefined>();

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

<svelte:element
  this={as}
  {...rest}
  title={truncate ? undefined : title}
  scope={as === 'th' ? 'row' : undefined}
  class={classNames('cinder-table__cell', className)}
  data-cinder-align={align}
  data-cinder-truncate={truncate || undefined}
  data-cinder-controls={controls || undefined}
>
  {#if truncate}
    <span class="cinder-table__cell-text" title={title ?? renderedText} {@attach readRenderedText}>
      {@render children?.()}
    </span>
  {:else}
    {@render children?.()}
  {/if}
</svelte:element>
