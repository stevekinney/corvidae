<script lang="ts">
  /**
   * `<svelte:boundary>` wrapper rendering the fault treatment inline (plan
   * §10.4, T1.5). Frozen after the Phase 1 Foundation gate — see
   * PROJECT-BRIEF "Shared contracts".
   *
   * One `FaultDisplay`-style banner for all six treatments (design reference:
   * `design/Weft Patterns.dc.html` "Fault / error banner, six fault codes"),
   * drawn by `fault-error-state.svelte` on a Cinder `ErrorState`, which also shows the
   * fault's `remediation` and offers Retry only when the fault is not `retryable: false`.
   * `Internal` additionally shows a
   * collapsible stack trace when the caught error is NOT an `HttpClientError`
   * (i.e. a rendering bug the boundary caught directly, never a wire fault) —
   * matching the design reference's "Collapsible stack trace" panel next to
   * the 500 row. Every `HttpClientError` also has a JS `.stack` (all `Error`
   * subclasses do), but it would only ever be the browser-side call stack of
   * where the client threw — weft never puts the server's actual stack on
   * the wire (`shapeRestFault` masks `EngineFailure` precisely so internal
   * detail doesn't leak to REST clients), so showing it would look like real
   * diagnostic information while actually being noise.
   *
   * `onerror` is reporting-only; `reset()` is wired to nothing but the
   * banner's own Retry button, on explicit user action — calling `reset()`
   * from `onerror` would just re-run the same failing subtree synchronously.
   */
  import { keyedByOccurrence } from '../lib/list-keys.ts';
  import type { Snippet } from 'svelte';

  import { Collapsible } from '@lostgradient/cinder';

  import { HttpClientError } from '@lostgradient/weft/client';

  import FaultErrorState from './fault-error-state.svelte';

  import { classifyFault, UNKNOWN_FAULT_TREATMENT, type FaultTreatment } from '../lib/faults.ts';

  interface FaultBoundaryProps {
    /** The content that may fail. */
    children: Snippet;
    /**
     * Called once when the boundary catches an error, before the failed
     * banner renders — for logging/telemetry only. Never call `reset()` from
     * here; see the module doc.
     */
    onFault?: ((treatment: FaultTreatment, error: unknown) => void) | undefined;
  }

  let { children, onFault }: FaultBoundaryProps = $props();

  function reportFault(error: unknown): void {
    onFault?.(classifyFault(error) ?? UNKNOWN_FAULT_TREATMENT, error);
  }

  function stackTraceOf(error: unknown): string | undefined {
    if (error instanceof HttpClientError) return undefined;
    return error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined;
  }

  function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'Error';
  }
</script>

<svelte:boundary onerror={(error: unknown) => reportFault(error)}>
  {@render children()}

  {#snippet failed(error: unknown, reset: () => void)}
    {@const treatment = classifyFault(error) ?? UNKNOWN_FAULT_TREATMENT}
    {@const stack = treatment.kind === 'internal' ? stackTraceOf(error) : undefined}
    <!-- Retry is the app's one word for asking again (COR-2489), offered only when the fault can be retried (COR-2560). -->
    <!-- A bug caught while rendering says nothing about the server, so Open Health cannot help with it. -->
    <FaultErrorState {treatment} offerHealth={classifyFault(error) !== null} onRetry={reset}>
      {#if treatment.kind === 'conflict' && treatment.isSpentIdempotencyKey}
        <p class="weft-fault-boundary__note">
          This idempotency key has already been used and its run was purged — start with a new key.
        </p>
      {/if}

      {#if treatment.kind === 'invalid' && treatment.fieldErrors.length > 0}
        <ul class="weft-fault-boundary__field-errors">
          {#each keyedByOccurrence(treatment.fieldErrors, (candidate) => candidate.path) as { key, item: fieldError } (key)}
            <li><code>{fieldError.path}</code> — {fieldError.message}</li>
          {/each}
        </ul>
      {/if}

      {#if treatment.kind === 'internal' && treatment.tryViaJsonRpc}
        <p class="weft-fault-boundary__note">
          The REST API hides internal error detail on this response — the same request over JSON-RPC
          returns the full fault.
        </p>
      {/if}

      {#if stack}
        <Collapsible trigger={errorName(error)}>
          <pre class="weft-fault-boundary__stack">{stack}</pre>
        </Collapsible>
      {/if}
    </FaultErrorState>
  {/snippet}
</svelte:boundary>

<!-- Styles: the `.weft-fault-boundary__*` rules for what sits under the row (note, field errors,
     stack) live in src/styles/foundation.css (plain global) because
     `fault-error-state.svelte` draws their container and
     src/routes/system/query-fault-banner.svelte fills it with the same notes — a scoped <style>
     block here would never reach them. -->
