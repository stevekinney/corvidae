<script lang="ts">
  /*
   * The before/after list of a proposed reference or recipe change (COR-488): every public
   * value that changes, once per path and concrete context, with what stays the same only
   * counted. It is a plain table, never a graph. The result is bound to the draft revision it
   * was computed for; once the draft moves on, the list says so and Apply is withheld.
   */
  import { Button } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';

  import type { Impact } from './theme-impact.ts';

  type Props = {
    impact: Extract<Impact, { ok: true }>;
    /** The proposal's title, for example `Rebind fx.b`. */
    title: string;
    stale: boolean;
    idBase: string;
    onapply: () => void;
    oncancel: () => void;
    /** Extra content before the actions, for example the checks this change would move. */
    children?: Snippet;
  };
  let { impact, title, stale, idBase, onapply, oncancel, children }: Props = $props();

  const PAGE = 40;
  let shown = $state(PAGE);

  const rows = $derived(impact.changed.slice(0, shown));
  const contexts = $derived(new Set(impact.changed.map((row) => row.context)).size);
  const paths = $derived(new Set(impact.changed.map((row) => row.path)).size);
  const summary = $derived(
    impact.changed.length === 0
      ? 'No value changes in any context.'
      : `${paths} ${paths === 1 ? 'token changes' : 'tokens change'} across ${contexts} ${contexts === 1 ? 'context' : 'contexts'}.`,
  );
</script>

<section class="impact" aria-labelledby={`${idBase}-title`} data-testid="impact-list">
  <h4 id={`${idBase}-title`} class="impact__title">{title}</h4>
  <p class="impact__summary" data-testid="impact-summary">
    {summary}
    {#if impact.unchanged > 0}
      <span data-testid="impact-unchanged"
        >{impact.unchanged} dependent {impact.unchanged === 1 ? 'value stays' : 'values stay'} the same.</span
      >
    {/if}
  </p>
  {#if stale}
    <p class="impact__stale" role="alert" data-testid="impact-stale">
      The draft changed after this preview was computed (revision {impact.revision}). Preview the
      change again before applying it.
    </p>
  {/if}
  {#if impact.changed.length > 0}
    <div class="impact__scroll" data-scroll-region={`${idBase}-impact`}>
      <table class="impact__table">
        <caption class="impact__caption">Values that change if you apply this</caption>
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
              <th scope="row">
                <code>{row.path}</code>
                {#if row.role === 'target'}<span class="impact__tag">this token</span>{/if}
                {#if row.sourceOnly}<span class="impact__tag">Source only</span>{/if}
              </th>
              <td data-label="Context">{row.context}</td>
              <td data-label="Before"><code>{row.authored?.before ?? row.before}</code></td>
              <td data-label="After"><code>{row.authored?.after ?? row.after}</code></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if impact.changed.length > shown}
      <Button
        label={`Show ${Math.min(PAGE, impact.changed.length - shown)} more`}
        variant="secondary"
        size="sm"
        onclick={() => (shown += PAGE)}
      />
    {/if}
  {/if}
  {@render children?.()}
  <div class="impact__actions">
    <Button label="Apply" variant="primary" disabled={stale} onclick={onapply} />
    <Button label="Cancel" variant="secondary" onclick={oncancel} />
  </div>
</section>

<style>
  .impact {
    display: grid;
    gap: 8px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
  .impact__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
  }
  .impact__summary,
  .impact__stale {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
  .impact__stale {
    color: var(--cinder-status-danger-text, var(--cinder-text-default));
  }
  .impact__scroll {
    max-height: 20rem;
    overflow: auto;
  }
  .impact__table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--cinder-text-xs);
  }
  .impact__caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  th,
  td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--cinder-border-muted);
    text-align: start;
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  code {
    font-family: var(--cinder-font-mono);
  }
  .impact__tag {
    margin-inline-start: 4px;
    color: var(--cinder-text-muted);
  }
  .impact__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  @media (max-width: 767.98px) {
    .impact__table,
    .impact__table tbody,
    .impact__table tr,
    .impact__table th,
    .impact__table td {
      display: block;
    }
    .impact__table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .impact__table td::before {
      content: attr(data-label);
      color: var(--cinder-text-muted);
    }
  }
  @media (max-width: 479.98px) {
    .impact__actions {
      flex-direction: column;
    }
  }
</style>
