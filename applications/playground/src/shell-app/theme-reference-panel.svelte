<script lang="ts">
  /*
   * References (COR-488): rebind an alias to a compatible token, replace an alias or a recipe
   * with a literal, change a recipe through its inputs, or give it a complete CSS value. Each
   * change is a proposal. Nothing commits until the author has seen every value that would
   * change, in all six contexts, and applies that exact result; a proposal the runtime rejects
   * (a type mismatch, a cycle, a missing target, an unsafe CSS value) is reported with the
   * path it concerns and leaves the draft, history and preview untouched.
   */
  import { Button, Input, Select } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import ThemeImpactList from './theme-impact-list.svelte';
  import { impactIsCurrent } from './theme-impact.ts';
  import {
    aliasCandidates,
    proposeCssOverride,
    proposeDetach,
    proposeRebind,
    type Proposal,
  } from './theme-reference-edits.ts';
  import { untrustedRecipes } from './theme-recipe-trust.ts';
  import { THEME_CONTEXT_IDS, contextId } from './theme-draft-types.ts';
  import {
    defaultScope,
    editorMode,
    overrideScopeFor,
    scopeOptions,
    type EditScope,
  } from './theme-token-edit.ts';
  import type { TokenEditorProps } from './theme-token-editors.ts';

  let { controller, workbench, row }: TokenEditorProps = $props();

  let scopeChoice = $state<EditScope>(untrack(() => defaultScope(row)));
  let proposal = $state.raw<Proposal | null>(null);
  let title = $state('');
  let picking = $state(false);
  let search = $state('');
  let overrideText = $state('');
  let overrideScope = $state<'context' | 'all'>('context');

  const draft = $derived(controller.draft);
  const envelope = $derived(draft?.envelope ?? null);
  const scope = $derived(overrideScopeFor(scopeChoice, workbench.context));
  const mode = $derived(envelope === null ? 'literal' : editorMode(row, envelope, scope));
  const options = $derived(scopeOptions(workbench.context));
  const idBase = $derived(`theme-builder-references-${row.path.replaceAll('.', '-')}`);
  const sourceOnly = $derived(row.cssProperty === '');
  const locked = $derived(controller.lockedPaths.has(row.path));
  const recipe = $derived(row.edit === 'recipe');
  const untrusted = $derived(
    envelope === null ? [] : untrustedRecipes(envelope).filter((site) => site.path === row.path),
  );
  const relevant = $derived(mode === 'alias' || recipe || untrusted.length > 0);
  const stale = $derived(
    proposal !== null && proposal.ok && !impactIsCurrent(proposal.impact, draft),
  );
  // The candidate list needs the full provenance, so it is only computed once the picker opens.
  const candidates = $derived(
    picking && draft !== null ? aliasCandidates(draft, row, search) : { items: [], total: 0 },
  );

  $effect(() => {
    if (!options.find((option) => option.value === scopeChoice)?.disabled) return;
    scopeChoice = defaultScope(row);
  });

  function propose(label: string, make: () => Proposal): void {
    title = label;
    proposal = draft === null ? null : make();
    if (proposal !== null && !proposal.ok) controller.announcement = proposal.message;
  }

  const rebind = (target: string): void =>
    propose(`Rebind ${row.path} to ${target}`, () =>
      proposeRebind(draft!, row, workbench.context, scope, target),
    );

  const detach = (): void =>
    propose(`Replace ${row.path} with a literal`, () =>
      proposeDetach(draft!, row, workbench.context, scope),
    );

  const override = (): void =>
    propose(`Override the CSS value of ${row.path}`, () =>
      proposeCssOverride(
        draft!,
        row,
        overrideScope === 'all' ? THEME_CONTEXT_IDS : [contextId(workbench.context)],
        overrideText,
      ),
    );

  async function apply(): Promise<void> {
    if (proposal === null || !proposal.ok || stale) return;
    const { impact } = proposal;
    const outcome = await controller.commit({ kind: 'edit', label: title, state: impact.state });
    if (outcome.ok) {
      const count = new Set(impact.changed.map((entry) => entry.path)).size;
      controller.announcement = `${title}. ${count} ${count === 1 ? 'token' : 'tokens'} changed.`;
      proposal = null;
      picking = false;
      search = '';
    } else {
      proposal = {
        ok: false,
        message: `${outcome.path ?? row.path}: ${outcome.message}`,
        path: outcome.path,
      };
      controller.announcement = proposal.message;
    }
  }

  const cancel = (): void => {
    proposal = null;
    controller.announcement = 'Cancelled. Nothing changed.';
  };
</script>

{#if relevant}
  <section class="references" aria-labelledby={`${idBase}-heading`} data-testid="reference-panel">
    <h3 id={`${idBase}-heading`} class="references__heading">References</h3>

    {#if untrusted.length > 0}
      <div class="references__notice" data-testid="untrusted-recipe-note">
        <p>
          This token carries a CSS recipe that Cinder does not recognize. It is kept in the draft
          and ignored: it never runs, and the token uses its value instead.
        </p>
        <ul>
          {#each untrusted as site (site.document)}
            <li><code>{site.recipe}</code> in {site.document}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if mode !== 'css-only' && (mode === 'alias' || recipe)}
      <Select
        id={`${idBase}-scope`}
        label="Change applies to"
        {options}
        value={scopeChoice}
        onchange={(event) => (scopeChoice = event.currentTarget.value as EditScope)}
      />
    {/if}

    {#if mode === 'alias'}
      <p class="references__note" data-testid="reference-alias">
        This token is an alias{row.aliases.length > 0 ? ` of ${row.aliases.join(', ')}` : ''}. It
        stays linked until you rebind it or replace it with a literal here.
      </p>
      <div class="references__actions">
        <Button
          label={picking ? 'Close the alias picker' : 'Rebind alias'}
          variant="secondary"
          aria-expanded={picking}
          disabled={locked}
          onclick={() => {
            picking = !picking;
            proposal = null;
          }}
        />
        <Button
          label="Preview replacing with literal"
          variant="secondary"
          disabled={locked}
          onclick={detach}
        />
      </div>
      {#if picking}
        <div class="references__picker">
          <Input
            id={`${idBase}-search`}
            label={`Search tokens ${row.path} can alias`}
            description="Only tokens with the same effective type in every context are listed."
            autocomplete="off"
            spellcheck={false}
            value={search}
            onValueChange={(next) => (search = next)}
          />
          {#if candidates.items.length === 0}
            <p class="references__note" data-testid="alias-empty">No compatible token matches.</p>
          {:else}
            <ul
              class="references__list"
              aria-label="Compatible tokens"
              data-testid="alias-candidates"
            >
              {#each candidates.items as candidate (candidate.path)}
                <li>
                  <Button
                    label={`${candidate.path}`}
                    aria-label={`Alias ${row.path} to ${candidate.path}`}
                    variant="ghost"
                    size="sm"
                    onclick={() => rebind(candidate.path)}
                  />
                  <span class="references__type">{candidate.type}</span>
                </li>
              {/each}
            </ul>
            {#if candidates.total > candidates.items.length}
              <p class="references__note">
                Showing {candidates.items.length} of {candidates.total}. Search to narrow the list.
              </p>
            {/if}
          {/if}
        </div>
      {/if}
    {/if}

    {#if recipe}
      <p class="references__note" data-testid="reference-recipe">
        This token's CSS comes from a trusted recipe{row.recipeInputs.length > 0
          ? ' that reads'
          : '.'}
      </p>
      {#if row.recipeInputs.length > 0}
        <ul class="references__list" aria-label="Recipe inputs">
          {#each row.recipeInputs as input (input)}
            <li>
              <code>{input}</code>
              <Button
                label="Edit input"
                aria-label={`Edit recipe input ${input}`}
                variant="secondary"
                size="sm"
                onclick={() => workbench.followToken(input, row.path)}
              />
            </li>
          {/each}
        </ul>
      {/if}
      <div class="references__override">
        <Input
          id={`${idBase}-override`}
          label={`Complete CSS value for ${row.path}`}
          description="A typed CSS value or a var(--cinder-…) to a public token of the same kind. Urls, semicolons and other functions are rejected."
          autocomplete="off"
          spellcheck={false}
          value={overrideText}
          {...proposal !== null && !proposal.ok && title.startsWith('Override')
            ? { error: proposal.message }
            : {}}
          onValueChange={(next) => (overrideText = next)}
        />
        <Select
          id={`${idBase}-override-scope`}
          label="Override applies to"
          options={[
            { value: 'context', label: `This context (${contextId(workbench.context)})` },
            { value: 'all', label: 'All six contexts' },
          ]}
          value={overrideScope}
          onchange={(event) => (overrideScope = event.currentTarget.value as 'context' | 'all')}
        />
        <div class="references__actions">
          <Button
            label="Preview CSS override"
            variant="secondary"
            disabled={locked}
            onclick={override}
          />
          {#if !sourceOnly}
            <Button
              label="Preview replacing recipe with literal"
              variant="secondary"
              disabled={locked}
              onclick={detach}
            />
          {/if}
        </div>
      </div>
    {/if}

    {#if proposal !== null && proposal.ok}
      <ThemeImpactList
        impact={proposal.impact}
        {title}
        {stale}
        {idBase}
        onapply={() => void apply()}
        oncancel={cancel}
      />
    {:else if proposal !== null && !(title.startsWith('Override') && recipe)}
      <p class="references__error" role="alert" data-testid="reference-error">{proposal.message}</p>
    {/if}
  </section>
{/if}

<style>
  .references,
  .references__picker,
  .references__override,
  .references__notice {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .references__heading {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  .references__note,
  .references__notice p {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
  .references__error {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-status-danger-text, var(--cinder-text-default));
  }
  .references__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .references__list {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 14rem;
    overflow: auto;
    font-size: var(--cinder-text-sm);
  }
  .references__list li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .references__type {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }
  @media (max-width: 479.98px) {
    .references__actions {
      flex-direction: column;
    }
  }
</style>
