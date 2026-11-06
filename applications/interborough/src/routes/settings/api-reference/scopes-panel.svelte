<script lang="ts">
  /**
   * The Your scopes tab (board PageSettingsSections, "API reference · Your scopes"): what this
   * session may do. Interborough is single-user for now, so these are the scopes of the person at
   * the keyboard, and the page's own boards act with them. Each scope is a small monospaced name
   * with what it lets the session do. A forbidden page links here (`app/copy.ts`, `scopes`).
   */
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import { API_REFERENCE_COPY } from '../../../app/copy.ts';
  import { SCOPE_CATALOG } from '../../system/scope-catalog.ts';

  const principal = getPrincipalStore();
  const copy = API_REFERENCE_COPY.scopes;

  const granted = $derived(SCOPE_CATALOG.filter((entry) => principal.hasScope(entry.scope)));
</script>

<div class="ib-scopes" data-testid="api-scopes">
  <p class="ib-scopes__intro">{copy.intro}</p>
  {#if granted.length === 0}
    <p class="ib-scopes__muted">{copy.none}</p>
  {:else}
    <ul class="ib-scopes__list" aria-label={copy.listLabel}>
      {#each granted as entry (entry.scope)}
        <li data-scope={entry.scope}>
          <code class="ib-scopes__name">{entry.scope}</code>
          <span>{entry.description}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ib-scopes {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-scopes__intro,
  .ib-scopes__muted {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }

  .ib-scopes__muted {
    color: var(--cinder-text-muted);
  }

  .ib-scopes__list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }

  .ib-scopes__list > li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: baseline;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    font-size: var(--cinder-text-sm);
  }

  .ib-scopes__list > li + li {
    border-block-start: 1px solid var(--cinder-border-muted);
  }

  .ib-scopes__name {
    font-size: var(--cinder-text-xs);
  }
</style>
