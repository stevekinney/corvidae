<script lang="ts">
  /*
   * The preview frame's page: one scene, drawn from trusted Cinder examples only. The
   * scene id arrives from the builder over the validated message channel; an unknown id
   * falls back to the default scene rather than rendering anything the manifest does
   * not name.
   */
  import { DEFAULT_THEME_PREVIEW_SCENE_ID, themePreviewSceneById } from './theme-preview-scenes.ts';
  import {
    exampleComponent,
    THEME_PREVIEW_EXAMPLE_LOADERS,
  } from './theme-preview-example-loaders.ts';
  import Specimens from './theme-preview-specimens.svelte';

  type Props = { sceneId: string };
  let { sceneId }: Props = $props();

  const scene = $derived(
    themePreviewSceneById(sceneId) ?? themePreviewSceneById(DEFAULT_THEME_PREVIEW_SCENE_ID)!,
  );
  const isApplication = $derived(scene.category === 'Application');
  // The settings form comes first, then the summary; the overlay actions close the page.
  const FORM_EXAMPLES = ['input/basic', 'select/basic', 'checkbox/basic', 'button/variants'];
  const SUMMARY_EXAMPLES = ['callout/variants', 'table/basic', 'line-chart/multi-series'];
  const OVERLAY_EXAMPLES = ['modal/with-form', 'popover/basic'];
  const applicationGroups = [
    { id: 'settings', title: 'Settings', examples: FORM_EXAMPLES },
    { id: 'summary', title: 'Summary', examples: SUMMARY_EXAMPLES },
  ];
</script>

{#snippet example(exampleId: string, prefix: string)}
  {@const load = THEME_PREVIEW_EXAMPLE_LOADERS[exampleId]}
  <div class="example" data-example={exampleId}>
    {#if load === undefined}
      <p role="alert">No trusted example is registered for {exampleId}.</p>
    {:else}
      {#await load() then module}
        {@const Example = exampleComponent(module)}
        <Example mountIdPrefix={prefix} />
      {:catch}
        <p role="alert">The {exampleId} example could not be loaded.</p>
      {/await}
    {/if}
  </div>
{/snippet}

<main class="stage" data-scene={scene.id} data-category={scene.category}>
  <h1 class="scene-title">{scene.title}</h1>
  {#if scene.id === 'foundations/specimens'}
    <Specimens />
  {:else if isApplication}
    <div class="application">
      {#each applicationGroups as group (group.id)}
        <section class="application__group" aria-labelledby={`application-${group.id}`}>
          <h2 id={`application-${group.id}`}>{group.title}</h2>
          {#each group.examples as exampleId (exampleId)}
            {@render example(exampleId, `preview-${group.id}-${exampleId.replace('/', '-')}`)}
          {/each}
        </section>
      {/each}
    </div>
    <section class="application__overlays" aria-labelledby="application-overlays">
      <h2 id="application-overlays">Actions</h2>
      <div class="overlay-row">
        {#each OVERLAY_EXAMPLES as exampleId (exampleId)}
          {@render example(exampleId, `preview-overlay-${exampleId.replace('/', '-')}`)}
        {/each}
      </div>
    </section>
  {:else}
    {#each scene.examples as exampleId (exampleId)}
      {@render example(exampleId, `preview-${exampleId.replace('/', '-')}`)}
    {/each}
  {/if}
</main>

<style>
  .stage {
    display: grid;
    gap: var(--cinder-space-4);
    min-width: 0;
  }
  .scene-title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: var(--cinder-font-semibold);
    color: var(--cinder-text-default);
  }
  .example {
    min-width: 0;
    overflow-x: auto;
  }
  .application {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--cinder-space-4);
  }
  .application__group {
    display: grid;
    gap: var(--cinder-space-4);
    align-content: start;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
    color: var(--cinder-text-muted);
  }
  .overlay-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-4);
  }
  /* Equal columns from 768px of preview width; below that the form stacks before the summary. */
  @media (min-width: 768px) {
    .application {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
  }
</style>
