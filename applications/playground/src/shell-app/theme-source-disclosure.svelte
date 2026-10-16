<script lang="ts">
  /*
   * Source and dependencies (COR-488), beside every token editor. An accessible list, never a
   * graph: the authored and resolved value, the effective type and where it is declared, the
   * winning source and the layers it overrides, what the token reads directly, what reads it
   * in each concrete context, the CSS properties it feeds, and how it exports.
   *
   * The provenance behind it is the expensive part of an evaluation, so nothing is computed
   * until the disclosure opens, and after a commit it is recomputed off the edit path: until
   * the new result lands, the list says which revision it shows. Following a dependent selects
   * it through the catalogue and offers Back to originating token.
   */
  import { Button, Collapsible } from '@lostgradient/cinder';

  import { catalogueRowByPath } from './theme-builder-catalogue.ts';
  import { inspectToken, type InspectionResult } from './theme-source-inspection.ts';
  import { isSourceOnly } from './theme-source-token-row.ts';
  import type { TokenEditorProps } from './theme-token-editors.ts';

  let { controller, workbench, row }: TokenEditorProps = $props();

  const PAGE = 20;

  let result = $state.raw<{ revision: number; inspected: InspectionResult } | null>(null);
  let shown = $state(PAGE);

  const draft = $derived(controller.draft);
  const open = $derived(workbench.sourceDisclosureOpen);
  const idBase = $derived(`theme-source-${row.path.replaceAll('.', '-')}`);
  const stale = $derived(result !== null && draft !== null && result.revision !== draft.revision);

  $effect(() => {
    const envelope = draft?.envelope;
    const revision = draft?.revision;
    if (!open || envelope === undefined || revision === undefined) return;
    const handle = setTimeout(() => {
      result = { revision, inspected: inspectToken(envelope, row) };
    }, 0);
    return () => clearTimeout(handle);
  });

  const followable = (path: string): boolean => catalogueRowByPath(path) !== undefined;
  const sourceOnly = $derived(isSourceOnly(row));
</script>

<div class="disclosure" data-testid="source-disclosure">
  <Collapsible
    trigger="Source and dependencies"
    {idBase}
    bind:open={workbench.sourceDisclosureOpen}
    animated={false}
    onToggle={(next: boolean) => {
      controller.announcement = next
        ? 'Source and dependencies expanded'
        : 'Source and dependencies collapsed';
    }}
  >
    <div class="body" aria-busy={result === null || stale}>
      {#if result === null}
        <p class="note" data-testid="source-loading">Reading the evaluated source…</p>
      {:else if !result.inspected.ok}
        <p class="note" data-testid="source-invalid">
          The draft does not evaluate, so there is no provenance to show. The runtime reports:
        </p>
        <ul class="plain">
          {#each result.inspected.diagnostics.slice(0, 5) as diagnostic (diagnostic.path + diagnostic.reason)}
            <li><code>{diagnostic.path}</code>: {diagnostic.reason}</li>
          {/each}
        </ul>
      {:else}
        {@const inspection = result.inspected.inspection}
        {#if stale}
          <p class="note" role="status" data-testid="source-stale">
            Showing revision {result.revision}; the draft is at revision {draft?.revision}.
            Updating.
          </p>
        {:else}
          <p class="note" data-testid="source-revision">Evaluated at revision {result.revision}.</p>
        {/if}

        <dl class="facts">
          {#if inspection.role !== null}
            <div>
              <dt>Role</dt>
              <dd>{inspection.role}</dd>
            </div>
          {/if}
          <div>
            <dt>CSS property</dt>
            <dd>
              {#if inspection.cssProperty === null}
                <span data-testid="source-only">Source only; no CSS property binding.</span>
              {:else}
                <code>{inspection.cssProperty}</code>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Public CSS usage</dt>
            <dd>
              {#if inspection.cssUsage.length === 0}
                None
              {:else}
                <code>{inspection.cssUsage.join(', ')}</code>
              {/if}
            </dd>
          </div>
          {#if inspection.disposition !== null}
            <div>
              <dt>Disposition</dt>
              <dd data-testid="source-disposition">
                Edit: {inspection.disposition.edit}. CSS export: {inspection.disposition.cssExport}.
                Portable export: {inspection.disposition.dtcgExport}.
                {#if inspection.disposition.reason !== undefined}
                  {inspection.disposition.reason}
                {/if}
              </dd>
            </div>
          {:else}
            <div>
              <dt>Disposition</dt>
              <dd data-testid="source-disposition">
                Edit: source. CSS export: none. Portable export: source value only.
              </dd>
            </div>
          {/if}
        </dl>

        {#if inspection.untrustedRecipes.length > 0}
          <p class="note" data-testid="source-untrusted">
            Unverified metadata supplied by source: a CSS recipe Cinder does not recognize. It is
            kept and ignored.
          </p>
        {/if}
        {#if inspection.inert.length > 0}
          <div data-testid="source-inert">
            <p class="note">Unverified metadata supplied by source (kept, never run):</p>
            <ul class="plain">
              {#each inspection.inert as item (item.namespace)}
                <li><code>{item.namespace}</code>: <code>{item.value}</code></li>
              {/each}
            </ul>
          </div>
        {/if}

        <ul class="contexts" aria-label="Value and dependents by context">
          {#each inspection.contexts as context (context.context)}
            <li class="context" data-context={context.context}>
              <h5 class="context__title">{context.context}</h5>
              <dl class="facts">
                <div>
                  <dt>Authored</dt>
                  <dd><code>{context.authored}</code></dd>
                </div>
                <div>
                  <dt>Resolved</dt>
                  <dd><code>{context.resolved}</code></dd>
                </div>
                <div>
                  <dt>Effective type</dt>
                  <dd>
                    {context.effectiveType}, {context.typeOrigin}; declared at {context.typeDeclaredAt}
                  </dd>
                </div>
                <div>
                  <dt>Winning source</dt>
                  <dd>
                    <code>{context.winner.path}</code> in <code>{context.winner.document}</code>
                  </dd>
                </div>
                <div>
                  <dt>Overridden layers</dt>
                  <dd>
                    {#if context.overridden.length === 0}
                      None
                    {:else}
                      {context.overridden.map((layer) => layer.document).join(', ')}
                    {/if}
                  </dd>
                </div>
                <div>
                  <dt>Reads</dt>
                  <dd>
                    {#if context.references.length === 0 && context.recipeInputs.length === 0}
                      Nothing
                    {:else}
                      {[
                        ...context.references,
                        ...context.recipeInputs.map((path) => `${path} (recipe input)`),
                      ].join(', ')}
                    {/if}
                  </dd>
                </div>
                <div>
                  <dt>Dependents</dt>
                  <dd>
                    {#if context.dependents.length === 0}
                      <span data-testid="no-dependents"
                        >No dependents in the evaluated contexts.</span
                      >
                    {:else}
                      <ul class="plain" aria-label={`Dependents in ${context.context}`}>
                        {#each context.dependents.slice(0, shown) as path (path)}
                          <li>
                            <code>{path}</code>
                            {#if followable(path)}
                              <Button
                                label="Follow"
                                aria-label={`Follow dependent ${path}`}
                                variant="ghost"
                                size="sm"
                                onclick={() => workbench.followToken(path, row.path)}
                              />
                            {:else}
                              <span class="note">Source only; not in the catalogue.</span>
                            {/if}
                          </li>
                        {/each}
                      </ul>
                      {#if context.dependents.length > shown}
                        <Button
                          label={`Show more dependents in ${context.context}`}
                          variant="secondary"
                          size="sm"
                          onclick={() => (shown += PAGE)}
                        />
                      {/if}
                    {/if}
                  </dd>
                </div>
              </dl>
            </li>
          {:else}
            <li class="note" data-testid="source-empty">
              {sourceOnly ? 'This Source token' : 'This token'} has no evaluated value in any context.
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </Collapsible>
</div>

<style>
  .disclosure,
  .body,
  .contexts,
  .context {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .contexts,
  .plain {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .context {
    padding: 8px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
  .context__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
  }
  .facts {
    display: grid;
    gap: 4px;
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
  .facts > div {
    display: grid;
    grid-template-columns: minmax(6rem, 8rem) minmax(0, 1fr);
    gap: 8px;
  }
  dt {
    color: var(--cinder-text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
  @media (max-width: 479.98px) {
    .facts > div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
  }
</style>
