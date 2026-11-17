<script lang="ts" module>
  export type { GroupedListProps } from './grouped-list.types.ts';
</script>

<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
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
