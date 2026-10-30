<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Renders an ordered set of term and value pairs that describe attributes of a single entity.
   * @tag metadata
   * @tag key-value
   * @useWhen Summarizing the properties of one record such as a user profile or order detail.
   * @useWhen Switching between stacked and inline term layouts via the variant prop.
   * @avoidWhen Iterating over a homogenous collection of records — use data-list or table instead.
   * @related data-list, table
   */
  export type {
    DescriptionListItem,
    DescriptionListProps,
    DescriptionListVariant,
  } from './description-list.types.ts';
</script>

<script lang="ts">
  import type { DescriptionListProps } from './description-list.types.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';
  import { formatDate } from '../../utilities/format-date.ts';
  import Button from '../button/button.svelte';
  import Chip from '../chip/chip.svelte';
  import CopyButton from '../copy-button/copy-button.svelte';

  let {
    items,
    variant = 'default',
    class: className,
    actions,
    ...rest
  }: DescriptionListProps = $props();

  /** The last characters an identifier always keeps, so two shortened IDs stay tellable apart. */
  const IDENTIFIER_TAIL_LENGTH = 4;

  function shortenIdentifier(value: string, requestedCharacters: number | undefined): string {
    // A caller can pass anything despite the types: keep a sane head length.
    const visibleCharacters =
      requestedCharacters !== undefined && Number.isFinite(requestedCharacters)
        ? Math.max(0, Math.floor(requestedCharacters))
        : 8;
    if (value.length <= visibleCharacters + IDENTIFIER_TAIL_LENGTH + 1) return value;
    return `${value.slice(0, visibleCharacters)}…${value.slice(-IDENTIFIER_TAIL_LENGTH)}`;
  }

  type ReadableTimestamp =
    { valid: true; iso: string; readable: string; exact: string } | { valid: false };

  function readTimestamp(
    value: Date | string | number,
    locale: string,
    timeZone: string,
  ): ReadableTimestamp {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return { valid: false };
    return {
      valid: true,
      iso: date.toISOString(),
      readable: formatDate(date, locale, {
        timeZone,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }),
      exact: formatDate(date, locale, { timeZone, dateStyle: 'full', timeStyle: 'long' }),
    };
  }

  function systemTagLabel(count: number): string {
    return `${count} system ${count === 1 ? 'tag' : 'tags'}`;
  }

  // The each-block keys on `item.id ?? item.term`. Two rows that share a term and
  // omit `id` collide, which Svelte surfaces as a hard `each_key_duplicate` error
  // in dev and as broken DOM reconciliation in production. Surface the misuse with
  // an actionable diagnostic before the reconciler trips, so the consumer is told
  // to supply `id` rather than left to debug a cryptic error.
  const duplicateKey = $derived.by(() => {
    const seen = new Set<string | number>();
    for (const item of items) {
      const key = item.id ?? item.term;
      if (seen.has(key)) return key;
      seen.add(key);
    }
    return undefined;
  });

  // Warn at most once per distinct duplicate key. devWarn does not dedupe, so without
  // this latch the effect would re-spam the console on every reactive update (item
  // edits, unrelated prop changes) while the duplicate persists.
  let lastWarnedDuplicateKey: string | undefined;
  $effect(() => {
    if (duplicateKey === undefined) {
      lastWarnedDuplicateKey = undefined;
      return;
    }
    if (duplicateKey !== lastWarnedDuplicateKey) {
      lastWarnedDuplicateKey = duplicateKey;
      devWarn(
        `[cinder/DescriptionList] Duplicate key "${duplicateKey}". Two items share a term and no \`id\`. Provide a unique \`id\` on each DescriptionListItem to avoid broken reconciliation.`,
      );
    }
  });
</script>

<dl
  {...rest}
  class={classNames('cinder-description-list', className)}
  data-cinder-variant={variant}
>
  {#each items as item (item.id ?? item.term)}
    <div class="cinder-description-list__row">
      <dt class={variant === 'narrow' ? 'cinder-sr-only' : 'cinder-_label-text'}>{item.term}</dt>
      <dd class="cinder-_value-text">
        <div class="cinder-description-list__definition">
          {#if typeof item.definition === 'string'}
            {item.definition}
          {:else if typeof item.definition === 'function'}
            {@render item.definition()}
          {:else if item.definition.type === 'timestamp'}
            {@const timestamp = readTimestamp(
              item.definition.value,
              item.definition.locale ?? 'en-US',
              item.definition.timeZone ?? 'UTC',
            )}
            {#if timestamp.valid}
              <time
                class="cinder-description-list__timestamp"
                datetime={timestamp.iso}
                title={timestamp.exact}>{timestamp.readable}</time
              >
            {:else}
              <span class="cinder-description-list__empty">Invalid date</span>
            {/if}
          {:else if item.definition.type === 'identifier'}
            <span class="cinder-description-list__identifier-group">
              <code class="cinder-description-list__identifier" title={item.definition.value}
                >{shortenIdentifier(
                  item.definition.value,
                  item.definition.visibleCharacters ?? 8,
                )}</code
              >
              <CopyButton
                value={item.definition.value}
                label={`Copy ${item.term}`}
                copiedLabel={`${item.term} copied`}
                iconOnly
              />
            </span>
          {:else}
            {@const tags = item.definition}
            <span class="cinder-description-list__tags">
              {#if tags.tags.length > 0}
                <ul class="cinder-description-list__tag-list" aria-label={item.term}>
                  {#each tags.tags as tag (tag)}
                    <li><Chip label={tag} size="sm" /></li>
                  {/each}
                </ul>
              {:else if !tags.systemTagCount && !tags.onAddTag}
                <span class="cinder-description-list__empty">No tags</span>
              {/if}
              {#if tags.systemTagCount}
                <span class="cinder-description-list__system-tags">
                  {systemTagLabel(tags.systemTagCount)}
                </span>
              {/if}
              {#if tags.onAddTag}
                <Button size="xs" variant="ghost" onclick={tags.onAddTag}>Add a tag</Button>
              {/if}
            </span>
          {/if}
        </div>
        {#if actions}
          <div class="cinder-description-list__actions">{@render actions(item)}</div>
        {/if}
      </dd>
    </div>
  {/each}
</dl>
