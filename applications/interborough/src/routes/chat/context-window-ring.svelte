<script lang="ts">
  /**
   * The ring in a chat's header that says how full its context window is (`bureau.contexts.window`),
   * and opens to what fills it. The ring and its percentage are the estimate of the next prompt over
   * the window of the model that would answer; a model the catalog does not know leaves the ring
   * empty and says the token count alone. The panel splits the estimate by what fills the window
   * (the instructions, the tools, the messages, memory and attachments), one meter each, and adds
   * the provider's own count for the latest step, which lags the estimate by that step's reply.
   *
   * Cinder has no ring, so it is drawn here; it is decoration over the button's name and reading.
   */
  import { Button, Meter, Popover } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import type { ContextWindow } from '../../lib/bureau-client.ts';
  import { formatTokens, windowUse } from './context-window.ts';

  interface ContextWindowRingProps {
    /** The report, `undefined` until it is read or when it could not be. */
    report: ContextWindow | undefined;
    /** Whether the report could not be read. */
    failed?: boolean;
  }

  let { report, failed = false }: ContextWindowRingProps = $props();

  const COPY = CHAT_COPY.contextWindow;
  const RADIUS = 7;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  let open = $state(false);
</script>

{#if report !== undefined}
  {@const use = windowUse(report)}
  {@const used = formatTokens(use.used)}
  {@const max = use.max === null ? null : formatTokens(use.max)}
  <!-- A category's meter is drawn over the window, or over the estimate when the window is unknown. -->
  {@const scale = Math.max(use.max ?? 0, use.used, 1)}
  <Popover bind:open placement="bottom-end" label={COPY.label} focusManagement="preserve">
    {#snippet trigger()}
      <Button
        variant="ghost"
        size="sm"
        class="weft-context-ring"
        aria-label={COPY.trigger(use.percent, used, max)}
        data-tone={use.tone}
        onclick={() => (open = !open)}
      >
        <svg class="weft-context-ring__svg" viewBox="0 0 20 20" aria-hidden="true">
          <circle class="weft-context-ring__track" cx="10" cy="10" r={RADIUS} />
          <circle
            class="weft-context-ring__fill"
            cx="10"
            cy="10"
            r={RADIUS}
            stroke-dasharray={`${String(use.drawn * CIRCUMFERENCE)} ${String(CIRCUMFERENCE)}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span class="weft-context-ring__reading">{COPY.reading(use.percent, used)}</span>
      </Button>
    {/snippet}
    <div class="weft-context-window" data-testid="context-window">
      <p class="weft-context-window__summary">{COPY.summary(used, max)}</p>
      <p class="weft-context-window__note">{COPY.estimate}</p>
      <ul class="weft-context-window__categories" aria-label={COPY.breakdown}>
        {#each report.categories as category (category.name)}
          {@const name = COPY.categories[category.name]}
          {@const tokens = formatTokens(category.tokens)}
          <li class="weft-context-window__category" data-category={category.name}>
            <span class="weft-context-window__name">{name}</span>
            <span class="weft-context-window__tokens">{tokens}</span>
            <Meter
              size="sm"
              value={category.tokens}
              max={scale}
              ariaLabel={COPY.category(name, tokens)}
            />
          </li>
        {/each}
      </ul>
      <p class="weft-context-window__note">
        {report.usedReported === null
          ? COPY.notReported
          : COPY.reported(formatTokens(report.usedReported))}
      </p>
    </div>
  </Popover>
{:else if failed}
  <span class="weft-context-ring__unavailable">{COPY.unavailable}</span>
{/if}
