<script lang="ts">
  /**
   * Asks a run a question (`weft.workflows.query`): the name of a query the workflow answers and,
   * optionally, its input as JSON. Read-only, so it keeps no history; the answer is shown under the
   * form. The page owns the call (`runQuery`), which throws what the engine refused with.
   */
  import { Button, Input, Tooltip } from '@lostgradient/cinder';

  import { RUN_PAGE_COPY } from '../../../app/copy.ts';
  import type { ScopeGate } from '../../../lib/scopes.svelte.ts';

  interface RunQueryProps {
    /** Runs the query and resolves with its answer, or throws. */
    onRunQuery: (name: string, input: string) => Promise<unknown>;
    /** Whether `queries:read` is held. */
    gate?: ScopeGate | undefined;
  }

  let { onRunQuery, gate = { disabled: false, title: undefined } }: RunQueryProps = $props();

  let name = $state('');
  let inputText = $state('');
  let pending = $state(false);
  let failure = $state<string | null>(null);
  let resultText = $state<string | null>(null);

  async function run(): Promise<void> {
    if (name.trim().length === 0) return;
    pending = true;
    failure = null;
    resultText = null;
    try {
      const result = await onRunQuery(name.trim(), inputText);
      resultText = JSON.stringify(result ?? null, null, 2);
    } catch (error) {
      failure = error instanceof Error ? error.message : RUN_PAGE_COPY.queryFailed;
    } finally {
      pending = false;
    }
  }
</script>

<div class="weft-send-tab__form">
  <Input
    id="run-query-name"
    label={RUN_PAGE_COPY.queryName}
    placeholder="getOrderStatus"
    bind:value={name}
  />
  <Input
    id="run-query-input"
    label={RUN_PAGE_COPY.queryInput}
    placeholder={'{}'}
    bind:value={inputText}
  />
  <Tooltip text={gate.title ?? ''}>
    <Button
      data-changes
      variant="primary"
      size="sm"
      label={pending ? RUN_PAGE_COPY.queryRunning : RUN_PAGE_COPY.queryRun}
      loading={pending}
      disabled={gate.disabled || name.trim().length === 0}
      onclick={() => void run()}
    />
  </Tooltip>
  {#if failure}
    <p class="weft-send-tab__error">{failure}</p>
  {/if}
  {#if resultText !== null}
    <pre class="weft-send-tab__result">{resultText}</pre>
  {/if}
</div>
