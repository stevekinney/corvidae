<script lang="ts">
  /*
   * The editor slot. It identifies the selected token and renders whatever editor a later
   * issue supplies through `editor` (COR-489 foundation editors, COR-263 palettes, COR-488
   * composites). Until then it states what is selected and that editing arrives later.
   */
  import { Button } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';

  import { catalogueRowByPath } from './theme-builder-catalogue.ts';
  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import ThemePalettePanel from './theme-palette-panel.svelte';
  import ThemeReferencePanel from './theme-reference-panel.svelte';
  import ThemeSourceDisclosure from './theme-source-disclosure.svelte';
  import { tick } from 'svelte';
  import { editorForToken } from './theme-token-editors.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = {
    workbench: ThemeWorkbenchState;
    editor?: Snippet<[ThemeWorkbenchState]> | undefined;
    controller?: ThemeBuilderController | undefined;
  };
  let { workbench, editor, controller }: Props = $props();

  const row = $derived(catalogueRowByPath(workbench.selectedTokenPath));
  let paletteOpen = $state(false);

  /** Back to originating token: reselect it, then return focus to its disclosure trigger. */
  async function backToOrigin(): Promise<void> {
    const origin = workbench.returnToOrigin();
    if (origin === null) return;
    if (controller !== undefined) {
      controller.announcement = `Showing ${origin}, where you started.`;
    }
    await tick();
    const base = `theme-source-${origin.replaceAll('.', '-')}`;
    document.getElementById(`${base}-header`)?.focus();
  }
</script>

<section class="editor" aria-labelledby="editor-heading" data-testid="editor-slot">
  <h2 id="editor-heading">Selected token</h2>
  {#if controller !== undefined}
    <div class="palette-entry">
      <Button
        label={paletteOpen ? 'Close Create palette' : 'Create palette'}
        variant="secondary"
        aria-expanded={paletteOpen}
        onclick={() => (paletteOpen = !paletteOpen)}
      />
    </div>
    {#if paletteOpen}
      <ThemePalettePanel {controller} {workbench} onClose={() => (paletteOpen = false)} />
    {/if}
  {/if}
  {#if workbench.originTokenPath !== null && workbench.originTokenPath !== workbench.selectedTokenPath}
    <div>
      <Button
        label="Back to originating token"
        aria-label={`Back to originating token ${workbench.originTokenPath}`}
        variant="secondary"
        onclick={() => void backToOrigin()}
      />
    </div>
  {/if}
  {#if row === undefined}
    <p class="muted">Select a token in the catalogue to edit it.</p>
  {:else}
    <p class="name" data-testid="selected-token-name">{row.name}</p>
    <dl>
      <div>
        <dt>Path</dt>
        <dd><code data-testid="selected-token-path">{row.path}</code></dd>
      </div>
      <div>
        <dt>CSS property</dt>
        <dd><code>{row.cssProperty}</code></dd>
      </div>
      <div>
        <dt>Type</dt>
        <dd>{row.type}</dd>
      </div>
      <div>
        <dt>Context</dt>
        <dd>{row.context}</dd>
      </div>
    </dl>
    {#if row.description !== ''}
      <p class="muted">{row.description}</p>
    {/if}
  {/if}
  {#if editor !== undefined}
    {@render editor(workbench)}
  {:else if controller !== undefined && row !== undefined}
    {#key row.path}
      {@const Editor = editorForToken(row)}
      <Editor {controller} {workbench} {row} />
      <ThemeReferencePanel {controller} {workbench} {row} />
      <ThemeSourceDisclosure {controller} {workbench} {row} />
    {/key}
  {:else}
    <p class="muted">Value editors arrive with the token editors.</p>
  {/if}
</section>

<style>
  .editor {
    display: grid;
    gap: 8px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow-wrap: anywhere;
  }
  h2 {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  p {
    margin: 0;
  }
  .name {
    font-weight: var(--cinder-font-semibold);
  }
  .muted {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  dl {
    display: grid;
    gap: 4px;
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
  dl > div {
    display: grid;
    grid-template-columns: minmax(6rem, 8rem) minmax(0, 1fr);
    gap: 8px;
  }
  dt {
    color: var(--cinder-text-muted);
  }
  dd {
    margin: 0;
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
  @media (max-width: 479.98px) {
    dl > div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
  }
</style>
