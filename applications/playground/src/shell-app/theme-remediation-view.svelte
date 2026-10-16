<script lang="ts">
  /*
   * One remediation proposal, shown in full before its single Apply (COR-487): every changed
   * path with its before and after value, the resulting measurements, the gamut and the
   * algorithm version. A stale proposal says why and cannot be applied. The heading takes
   * focus when the author opens the proposal, so a keyboard user lands on what to review.
   */
  import { Button } from '@lostgradient/cinder';

  import type { RemediationProposal } from './theme-remediation-proposal.ts';

  type Props = {
    proposal: RemediationProposal;
    idBase: string;
    /** Why Apply is withheld, or `null`. */
    stale: string | null;
    busy: boolean;
    onapply: () => void;
    oncancel: () => void;
    /** Receives the heading so the parent can move focus to it. */
    heading?: ((node: HTMLElement) => void) | undefined;
  };
  let { proposal, idBase, stale, busy, onapply, oncancel, heading }: Props = $props();

  const ratio = (value: number | null): string =>
    value === null ? 'not measured' : `${value.toFixed(2)}:1`;
  const PAGE = 20;
  let shown = $state(PAGE);
  const rows = $derived(proposal.changes.slice(0, shown));
</script>

<section
  class="proposal"
  aria-labelledby={`${idBase}-title`}
  data-testid="remediation-proposal"
  data-action={proposal.action}
>
  <h4
    id={`${idBase}-title`}
    class="proposal__title"
    tabindex="-1"
    {@attach (node) => heading?.(node)}
  >
    {proposal.title}
  </h4>
  {#each proposal.notes as note (note)}
    <p class="proposal__note">{note}</p>
  {/each}
  <p class="proposal__note" data-testid="remediation-algorithm">
    Output gamut: {proposal.gamut === 'srgb' ? 'sRGB' : 'Display P3'}. Algorithm: {proposal.algorithmVersion}.
  </p>
  {#if stale !== null}
    <p class="proposal__stale" role="alert" data-testid="remediation-stale">{stale}</p>
  {/if}

  <div class="proposal__scroll" data-scroll-region={`${idBase}-changes`}>
    <table class="proposal__table">
      <caption>Values that change if you apply this</caption>
      <thead>
        <tr>
          <th scope="col">Token</th>
          <th scope="col">Context</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (`${row.path}@${row.context}`)}
          <tr data-role={row.role}>
            <th scope="row"><code>{row.path}</code></th>
            <td>{row.context}</td>
            <td><code>{row.before}</code></td>
            <td><code>{row.after}</code></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if proposal.changes.length > shown}
    <Button
      label={`Show ${Math.min(PAGE, proposal.changes.length - shown)} more`}
      variant="secondary"
      size="sm"
      onclick={() => (shown += PAGE)}
    />
  {/if}

  {#if proposal.measurements.length > 0}
    <div class="proposal__scroll" data-scroll-region={`${idBase}-measurements`}>
      <table class="proposal__table" data-testid="remediation-measurements">
        <caption>Resulting contrast of every affected pairing</caption>
        <thead>
          <tr>
            <th scope="col">Pairing</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
            <th scope="col">Required</th>
          </tr>
        </thead>
        <tbody>
          {#each proposal.measurements as row (row.pairingId)}
            <tr>
              <th scope="row">{row.description}</th>
              <td>{ratio(row.before)}</td>
              <td>{ratio(row.after)}</td>
              <td>{row.required === null ? 'no threshold' : `${row.required}:1`}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="proposal__actions" role="group" aria-label={`${proposal.label} actions`}>
    <Button
      label="Apply fix"
      variant="primary"
      size="sm"
      aria-label={`Apply fix: ${proposal.title}`}
      disabled={stale !== null || busy}
      onclick={onapply}
    />
    <Button label="Cancel" variant="secondary" size="sm" disabled={busy} onclick={oncancel} />
  </div>
</section>

<style>
  .proposal {
    display: grid;
    gap: 8px;
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
  .proposal__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
  }
  .proposal__title:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow:
      0 0 0 var(--cinder-ring-offset) var(--cinder-ring-offset-color),
      0 0 0 calc(var(--cinder-ring-offset) + var(--cinder-ring-width)) var(--cinder-ring-color);
  }
  @media (forced-colors: active) {
    .proposal__title:focus-visible {
      outline: var(--cinder-ring-width) solid Highlight;
      outline-offset: 3px;
    }
  }
  .proposal__note,
  .proposal__stale {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
  .proposal__note {
    color: var(--cinder-text-muted);
  }
  .proposal__stale {
    color: var(--cinder-status-danger-text, var(--cinder-text-default));
  }
  .proposal__scroll {
    max-inline-size: 100%;
    overflow-x: auto;
  }
  .proposal__table {
    border-collapse: collapse;
    inline-size: 100%;
    font-size: var(--cinder-text-sm);
  }
  .proposal__table caption {
    padding-block-end: 4px;
    text-align: start;
    color: var(--cinder-text-muted);
  }
  .proposal__table th,
  .proposal__table td {
    padding: 4px 6px;
    border-block-start: 1px solid var(--cinder-border-muted);
    text-align: start;
    overflow-wrap: anywhere;
    vertical-align: top;
  }
  .proposal__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
