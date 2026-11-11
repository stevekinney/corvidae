<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Inset group of rows on one rounded surface with inset separators, a header and footer outside the surface, and an optional quick-add first row.
   * @tag list
   * @tag group
   * @useWhen Listing related rows, such as settings, people or places, as one grouped surface instead of a stack of boxed cards.
   * @useWhen Adding items inline with a first row that takes text and submits on Return.
   * @avoidWhen Rows need a status column, details or a disclosure — use data-list with stacked-list-item.
   * @avoidWhen Comparing values across columns — use table.
   * @related grouped-list-item, section, data-list
   * @rationale Nearest alternative: DataList — a grouped list is one rounded surface with separators that start at the text, where a data list draws a border under every row.
   */
  export type { GroupedListProps } from './grouped-list.types.ts';
</script>

<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import type { GroupedListProps } from './grouped-list.types.ts';

  let {
    header,
    footer,
    children,
    onItemAdd,
    addLabel = 'Add an item',
    addPlaceholder,
    class: className,
    ...rest
  }: GroupedListProps = $props();

  const generatedId = $props.id();
  const headerId = $derived(`${generatedId}-header`);
  let draft = $state('');

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const value = draft.trim();
    if (value === '') return;
    onItemAdd?.(value);
    draft = '';
  }
</script>

<div class={classNames('cinder-grouped-list', className)}>
  {#if header}
    <p id={headerId} class="cinder-grouped-list__header">{header}</p>
  {/if}
  <ul {...rest} class="cinder-grouped-list__group" aria-labelledby={header ? headerId : undefined}>
    {#if onItemAdd}
      <li class="cinder-grouped-list__add">
        <form class="cinder-grouped-list__add-form" onsubmit={submit}>
          <span class="cinder-grouped-list__add-glyph" aria-hidden="true"><Plus size={18} /></span>
          <input
            class="cinder-grouped-list__add-input"
            type="text"
            aria-label={addLabel}
            placeholder={addPlaceholder ?? addLabel}
            enterkeyhint="done"
            autocomplete="off"
            bind:value={draft}
          />
        </form>
      </li>
    {/if}
    {#if children}{@render children()}{/if}
  </ul>
  {#if footer}
    <p class="cinder-grouped-list__footer">{footer}</p>
  {/if}
</div>
