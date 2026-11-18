<script lang="ts" module>
  export type { TableCellProps } from './table-cell.types.ts';
</script>

<script lang="ts">
  import type { Attachment } from 'svelte/attachments';

  import { createCutText } from '@lostgradient/foundation/_internal/cut-text.svelte.ts';
  import { tryGetTableContext } from '../table/table.context.ts';
  import type { TableCellProps } from './table-cell.types.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import FullTextTooltip from '@lostgradient/tooltip/_internal/full-text-tooltip.svelte';

  let {
    align = 'left',
    as = 'td',
    truncate = false,
    clamp = true,
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

  // In a `fit` table the row header is the row's title, stacked or not: it holds to two lines, and
  // while the clamp cuts it the whole of it opens in a tooltip from the title's link, or from the
  // title itself when it has none. A title that fits has no tab stop and no tooltip.
  const clampTitle = $derived(as === 'th' && !truncate && clamp && tableContext?.fit === true);
  const titleCut = createCutText('block');
  let titleText = $state<string | undefined>();
  const readTitleText: Attachment<HTMLElement> = (element) => {
    const read = (): void => {
      const text = element.textContent?.trim();
      titleText = text === undefined || text === '' ? undefined : text;
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
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

  // A caller can show a shorter form of a value than the one it passes as `title` (a storage key
  // with its UUID cut to eight characters). That value is cut by the page, not by the cell's width,
  // so it keeps the tooltip and the tab stop even when the short form fits.
  const shortened = $derived(
    typeof title === 'string' && renderedText !== undefined && title.trim() !== renderedText,
  );
  const fullTextShown = $derived(textCut.cut || shortened);
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
      tabindex={fullTextShown && textCut.inner === null ? 0 : undefined}
      {@attach readRenderedText}
      {@attach textCut.attach}
    >
      {@render children?.()}
    </span>{#if fullTextShown}<FullTextTooltip
        text={title ?? renderedText ?? ''}
        triggerRef={textCut.trigger}
      />{/if}
  {:else if clampTitle}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- the title is cut, so focusing it opens the tooltip with the whole title. -->
    <span
      class="cinder-table__cell-title"
      tabindex={titleCut.tabbable ? 0 : undefined}
      {@attach readTitleText}
      {@attach titleCut.attach}>{@render children?.()}</span
    >{#if titleCut.cut}<FullTextTooltip
        text={title ?? titleText ?? ''}
        triggerRef={titleCut.trigger}
      />{/if}
  {:else}
    {@render children?.()}
  {/if}{#if detail}<span class="cinder-table__cell-detail">{@render detail()}</span>{/if}
</svelte:element>
