<script lang="ts">
  /**
   * The chat's one context meter (COR-2438), in the composer's control row beside Send: a short bar
   * and its percentage, with the tokens behind it in a tooltip ("76K of 200K tokens"), which opens
   * to what fills the window. It reads `bureau.contexts.window`, the estimate of the next prompt over
   * the window of the model that would answer; a model the catalog does not know leaves the bar empty
   * and reads the token count, since there is no percentage to give. The panel splits the estimate
   * by what fills the window (the instructions, the tools, the messages, memory and attachments), one
   * meter each, and adds the provider's own count for the latest step, which lags the estimate by
   * that step's reply.
   *
   * There is one meter, in one format, in one place: the header has none. The bar's track carries a
   * control's rule, so an empty window still reads as a meter in both themes. It is composed from
   * Cinder's `Button`, `Meter`, `Popover` and `Tooltip`.
   */
  import { Button, Meter, Popover, Tooltip } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import type { ContextWindow } from '../../lib/bureau-client.ts';
  import {
    formatCompactTokens,
    formatTokens,
    WINDOW_DANGER_FRACTION,
    WINDOW_WARNING_FRACTION,
    windowUse,
  } from './context-window.ts';

  interface ContextMeterProps {
    /** The report, `undefined` until it is read or when it could not be. */
    report: ContextWindow | undefined;
    /** Whether the report could not be read. */
    failed?: boolean;
  }

  let { report, failed = false }: ContextMeterProps = $props();

  const COPY = CHAT_COPY.contextWindow;
  const SHORT = CHAT_COPY.contextMeter;

  let open = $state(false);
</script>

{#if report !== undefined}
  {@const use = windowUse(report)}
  {@const used = formatTokens(use.used)}
  {@const max = use.max === null ? null : formatTokens(use.max)}
  {@const shortUsed = formatCompactTokens(use.used)}
  {@const shortMax = use.max === null ? null : formatCompactTokens(use.max)}
  <!-- A category's meter is drawn over the window, or over the estimate when the window is unknown. -->
  {@const scale = Math.max(use.max ?? 0, use.used, 1)}
  <Popover bind:open placement="top-end" label={COPY.label} focusManagement="preserve">
    {#snippet trigger()}
      <Tooltip text={SHORT.tooltip(shortUsed, shortMax)} describe={false}>
        <Button
          variant="ghost"
          size="sm"
          class="weft-context-meter"
          aria-label={COPY.trigger(use.percent, used, max)}
          data-tone={use.tone}
          onclick={() => (open = !open)}
        >
          <span class="weft-context-meter__bar" aria-hidden="true">
            <Meter
              size="sm"
              value={Math.round(use.drawn * 100)}
              low={WINDOW_WARNING_FRACTION * 100}
              high={WINDOW_DANGER_FRACTION * 100}
              optimum={0}
              ariaLabel={SHORT.label(use.percent, shortUsed)}
            />
          </span>
          <span class="weft-context-meter__reading" aria-hidden="true"
            >{SHORT.reading(use.percent, shortUsed)}</span
          >
        </Button>
      </Tooltip>
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
  <span class="weft-context-meter__unavailable">{COPY.unavailable}</span>
{/if}
