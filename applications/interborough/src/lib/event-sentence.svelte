<script lang="ts">
  /**
   * An event in words: the sentence a plugin's event formatter writes for its kind
   * (`bureau.events.format`), or, when no formatter claims the kind, the raw kind (with the plain
   * words a caller gives it ahead of the kind). An event a plugin's contribution caused carries its
   * `source`, and the plugin is named beside it. A formatter that cannot be reached leaves the
   * event shown by its raw kind: the answer only ever adds words, and an event is never hidden.
   */
  import { Badge } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { PLUGIN_KINDS_COPY } from '../app/copy.ts';
  import { formatEvents } from './bureau-plugin-kinds.ts';
  import { queryKeys } from './query.ts';

  interface Props {
    /** The event's kind, such as `review.requested`. */
    kind: string;
    /** The plugin whose contribution caused the event, from the envelope's `source`. */
    source?: string;
    /** Plain words for the kind, shown ahead of it while no formatter claims it. */
    words?: string;
  }

  let { kind, source, words }: Props = $props();

  const formatted = createQuery(
    () => ({
      queryKey: queryKeys.eventSentence(kind, source ?? null),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const [first] = await formatEvents(
          [{ kind, ...(source === undefined ? {} : { source }) }],
          {
            signal,
          },
        );
        return first ?? null;
      },
      // The formatters are fixed once the Bureau is built, so a kind's wording does not change.
      staleTime: Infinity,
      retry: false,
    }),
    undefined,
  );

  const sentence = $derived(
    formatted.data?.formattedBy === undefined ? undefined : formatted.data.title,
  );
  const from = $derived(source ?? formatted.data?.source);
</script>

<span class="ib-event-sentence" role="group" aria-label={PLUGIN_KINDS_COPY.eventLabel}>
  {#if sentence !== undefined}
    <span class="ib-event-sentence__title" data-testid="event-sentence">{sentence}</span>
  {:else}
    {#if words !== undefined}
      <span class="ib-event-sentence__title" data-testid="event-words">{words}</span>
    {/if}
    <code class="ib-event-sentence__kind" data-testid="event-kind">{kind}</code>
  {/if}
  {#if from !== undefined}
    <Badge size="sm" variant="neutral" data-testid="event-source">
      {PLUGIN_KINDS_COPY.fromPlugin(from)}
    </Badge>
  {/if}
</span>

<style>
  .ib-event-sentence {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-event-sentence__kind {
    font-family: var(--cinder-font-mono);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
