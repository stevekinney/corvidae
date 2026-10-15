<script lang="ts">
  /*
   * The one path every reference or recipe change takes before it commits (COR-488): detach,
   * rebind, a recipe's CSS override and a CSS-only token's value. It shows the proposal's
   * revision-bound impact list, offers "Check this change" for the accessibility and
   * validation findings the change would introduce or resolve, and applies exactly the state
   * that was shown, as one transaction, while the draft is still at the revision it was
   * computed for. A rejected proposal shows its path-addressed message and changes nothing.
   */
  import { Button } from '@lostgradient/cinder';

  import ThemeImpactList from './theme-impact-list.svelte';
  import { checksEvaluator, computeChecksDelta, type ChecksDelta } from './theme-impact-checks.ts';
  import { impactIsCurrent } from './theme-impact.ts';
  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import type { Proposal } from './theme-reference-edits.ts';

  type Props = {
    controller: ThemeBuilderController;
    proposal: Proposal | null;
    title: string;
    idBase: string;
    /** Called after a successful Apply. */
    onapplied: () => void;
    /** Called when the author cancels, or the proposal is dismissed. */
    oncancel: () => void;
    /** Show a rejected proposal's message here; a caller that shows it at a field says no. */
    showError?: boolean;
  };
  let {
    controller,
    proposal,
    title,
    idBase,
    onapplied,
    oncancel,
    showError = true,
  }: Props = $props();

  let failure = $state<string | null>(null);
  let checks = $state.raw<ChecksDelta | 'running' | null>(null);

  const stale = $derived(
    proposal !== null && proposal.ok && !impactIsCurrent(proposal.impact, controller.draft),
  );

  // A new proposal starts without a stale failure or checks from the previous one.
  $effect(() => {
    void proposal;
    failure = null;
    checks = null;
  });

  async function apply(): Promise<void> {
    if (proposal === null || !proposal.ok || stale) return;
    const { impact } = proposal;
    const outcome = await controller.commit({ kind: 'edit', label: title, state: impact.state });
    if (outcome.ok) {
      const count = new Set(impact.changed.map((entry) => entry.path)).size;
      controller.announcement = `${title}. ${count} ${count === 1 ? 'token' : 'tokens'} changed.`;
      onapplied();
      return;
    }
    failure = `${outcome.path ?? impact.target}: ${outcome.message}`;
    controller.announcement = failure;
  }

  async function check(): Promise<void> {
    const draft = controller.draft;
    if (proposal === null || !proposal.ok || draft === null) return;
    const shown = proposal;
    checks = 'running';
    const result = await computeChecksDelta(checksEvaluator, draft.envelope, shown.impact.state);
    if (proposal === shown) checks = result;
  }
</script>

{#if proposal !== null && proposal.ok}
  <ThemeImpactList
    impact={proposal.impact}
    {title}
    {stale}
    {idBase}
    onapply={() => void apply()}
    {oncancel}
  >
    <div class="checks" data-testid="impact-checks">
      <Button
        label="Check this change"
        variant="secondary"
        size="sm"
        disabled={checks === 'running' || stale}
        onclick={() => void check()}
      />
      <div aria-live="polite">
        {#if checks === 'running'}
          <p class="note" data-testid="checks-running">Checking all six contexts…</p>
        {:else if checks !== null && !checks.ok}
          <p class="note" role="alert" data-testid="checks-invalid">{checks.message}</p>
        {:else if checks !== null}
          <p class="note" data-testid="checks-summary">
            {checks.introduced}
            {checks.introduced === 1 ? 'finding' : 'findings'} introduced,
            {checks.resolved} resolved.
          </p>
          <ul class="checks__list">
            {#each checks.bySeverity as entry (entry.severity)}
              <li data-severity={entry.severity}>
                <strong>{entry.severity}</strong>:
                {entry.introduced.length} introduced, {entry.resolved.length} resolved
                {#if entry.introduced.length > 0}
                  <ul aria-label={`Introduced ${entry.severity} findings`}>
                    {#each entry.introduced.slice(0, 10) as finding (finding.id)}
                      <li>{finding.message} ({finding.context})</li>
                    {/each}
                  </ul>
                {/if}
                {#if entry.resolved.length > 0}
                  <ul aria-label={`Resolved ${entry.severity} findings`}>
                    {#each entry.resolved.slice(0, 10) as finding (finding.id)}
                      <li>{finding.message} ({finding.context})</li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </ThemeImpactList>
  {#if failure !== null}
    <p class="error" role="alert" data-testid="reference-error">{failure}</p>
  {/if}
{:else if proposal !== null && showError}
  <p class="error" role="alert" data-testid="reference-error">{proposal.message}</p>
{/if}

<style>
  .checks {
    display: grid;
    gap: 8px;
  }
  .checks__list {
    display: grid;
    gap: 4px;
    margin: 0;
    padding-inline-start: 1rem;
    font-size: var(--cinder-text-sm);
  }
  .note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
  .error {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-status-danger-text, var(--cinder-text-default));
  }
</style>
