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

  import { createCutText } from '../../_internal/cut-text.svelte.ts';
  import { tryGetTableContext } from '../table/table.context.ts';
  import type { TableCellProps } from './table-cell.types.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import FullTextTooltip from '../../_internal/full-text-tooltip.svelte';

  let {
    align = 'left',
    as = 'td',
    truncate = false,
    controls = false,
    stack,
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
    return tableContext?.registerControls?.(controls !== 'fit');
  });

  // On a stacked `fit` table the row header is the card's title: it holds to two lines, and the
  // whole of it opens in a tooltip from the title's link, or from the title itself when it has none.
  const clampTitle = $derived(as === 'th' && !truncate && tableContext?.stackCard === true);
  let titleElement = $state<HTMLElement | null>(null);
  let titleTrigger = $state<HTMLElement | null>(null);
  let titleText = $state<string | undefined>();
  const holdTitle: Attachment<HTMLElement> = (element) => {
    const read = (): void => {
      const link = element.querySelector<HTMLElement>('a');
      if (!link) element.tabIndex = 0;
      titleTrigger = link ?? element;
      const text = element.textContent?.trim();
      titleText = text === undefined || text === '' ? undefined : text;
    };
    titleElement = element;
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      if (titleElement === element) {
        titleElement = null;
        titleTrigger = null;
      }
    };
  };

  // A truncating cell shows the full text on hover. Unless the caller supplied
  // a `title`, read it from the rendered text so a snippet child needs no
  // second copy of its own string. The attachment keeps it current when the
  // cell's content changes.
  let renderedText = $state<string | undefined>();

  // The cut text is focusable and opens a tooltip with the whole text, so a keyboard or touch user
  // reaches it too, in a row as well as in a link inside the cell.
  const textCut = createCutText();

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
  data-cinder-stack={stack}
  data-cinder-controls={controls === 'fit' ? 'fit' : controls ? '' : undefined}
>
  {#if truncate}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- the text is cut, so focusing it opens the tooltip with the whole text. -->
    <span
      class="cinder-table__cell-text"
      tabindex={textCut.tabbable ? '0' : undefined}
      {@attach readRenderedText}
      {@attach textCut.attach}
    >
      {@render children?.()}
    </span>{#if textCut.cut}<FullTextTooltip
        text={title ?? renderedText ?? ''}
        triggerRef={textCut.trigger}
      />{/if}
  {:else if clampTitle}
    <span class="cinder-table__cell-title" {@attach holdTitle}>{@render children?.()}</span
    ><FullTextTooltip text={title ?? titleText ?? ''} triggerRef={titleTrigger} />
  {:else}
    {@render children?.()}
  {/if}{#if detail}<span class="cinder-table__cell-detail">{@render detail()}</span>{/if}
</svelte:element>
