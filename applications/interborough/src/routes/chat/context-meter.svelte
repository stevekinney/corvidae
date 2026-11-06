<script lang="ts">
  /**
   * The context meter in the composer's control row: a short bar and its percentage, named "Context
   * 38%", with a tooltip that says the tokens behind it ("76K of 200K tokens"). It reads the same
   * `bureau.contexts.window` report as the header's ring, from the estimate of the next prompt over
   * the window of the model that would answer; a model the catalog does not know leaves the bar empty
   * and reads the token count alone. It is composed from Cinder's `Meter` and `Tooltip`.
   */
  import { Meter, Tooltip } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import type { ContextWindow } from '../../lib/bureau-client.ts';
  import {
    formatCompactTokens,
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

  const COPY = CHAT_COPY.contextMeter;
  let anchor = $state<HTMLElement | null>(null);
</script>

{#if report !== undefined}
  {@const use = windowUse(report)}
  {@const used = formatCompactTokens(use.used)}
  {@const max = use.max === null ? null : formatCompactTokens(use.max)}
  <span class="weft-context-meter" data-tone={use.tone} bind:this={anchor}>
    <span class="weft-context-meter__bar">
      <Meter
        size="sm"
        value={Math.round(use.drawn * 100)}
        low={WINDOW_WARNING_FRACTION * 100}
        high={WINDOW_DANGER_FRACTION * 100}
        optimum={0}
        ariaLabel={COPY.label(use.percent, used)}
        tabindex={0}
      />
    </span>
    <span class="weft-context-meter__reading" aria-hidden="true"
      >{COPY.reading(use.percent, used)}</span
    >
  </span>
  <Tooltip text={COPY.tooltip(used, max)} placement="top" triggerRef={anchor} describe={false} />
{:else if failed}
  <span class="weft-context-meter__unavailable">{COPY.unavailable}</span>
{/if}
