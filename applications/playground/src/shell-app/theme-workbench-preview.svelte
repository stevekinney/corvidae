<script lang="ts">
  /*
   * The preview slot: the category and scene selectors plus the trusted-fixture iframe.
   * The component is the builder's side of the message channel. It sends the workbench
   * state to the frame whenever the preview revision changes, resends it when the frame
   * announces `ready` (a first load or a reload starts with an empty variable map), and
   * records the frame's acknowledgements and named rejections in the workbench state.
   * Scene selection changes the revision and nothing else; it never touches the selected
   * token.
   */
  import { Callout, Select } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { ThemePreviewHost } from './theme-preview-host.ts';
  import {
    THEME_PREVIEW_CATEGORIES,
    themePreviewSceneById,
    themePreviewScenesInCategory,
    type ThemePreviewCategory,
  } from './theme-preview-scenes.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = { workbench: ThemeWorkbenchState; previewPath?: string | undefined };
  let { workbench, previewPath }: Props = $props();

  let frame: HTMLIFrameElement | undefined = $state();

  const scene = $derived(themePreviewSceneById(workbench.sceneId));
  const category = $derived(scene?.category ?? 'Components');
  const scenes = $derived(themePreviewScenesInCategory(category));
  const categoryOptions = THEME_PREVIEW_CATEGORIES.map((value) => ({ value, label: value }));
  const sceneOptions = $derived(scenes.map((entry) => ({ value: entry.id, label: entry.title })));
  // The initial scene is part of the frame URL; later changes arrive as messages, so the
  // frame is never reloaded by a scene change.
  const initialSrc = untrack(
    () =>
      `${previewPath ?? '/theme-builder/preview'}?scene=${encodeURIComponent(workbench.sceneId)}`,
  );

  const host = new ThemePreviewHost({
    frameWindow: () => frame?.contentWindow ?? null,
    origin: window.location.origin,
    onReady: () => {
      workbench.noteFrameLoading();
      sendCurrentState();
    },
    onApplied: (message) => workbench.noteApplied(message.revision),
    onRejected: (message) =>
      workbench.noteRejected({ code: message.code, message: message.detail }),
  });

  function sendCurrentState(): void {
    host.send({
      revision: workbench.revision,
      context: workbench.context,
      sceneId: workbench.sceneId,
      properties: workbench.properties,
    });
  }

  $effect(() => {
    window.addEventListener('message', host.handleEvent);
    return () => window.removeEventListener('message', host.handleEvent);
  });

  // Send on every revision. The context, scene, and properties are read untracked: the
  // revision is the single signal that they changed.
  $effect(() => {
    void workbench.revision;
    void frame;
    untrack(sendCurrentState);
  });

  function selectCategory(next: ThemePreviewCategory): void {
    const first = themePreviewScenesInCategory(next)[0];
    if (first !== undefined) workbench.selectScene(first.id);
  }
</script>

<section class="preview" aria-labelledby="preview-heading">
  <h2 id="preview-heading">Preview</h2>
  <div class="preview__selectors">
    <Select
      id="theme-builder-preview-category"
      label="Preview category"
      options={categoryOptions}
      value={category}
      onchange={(event) => selectCategory(event.currentTarget.value as ThemePreviewCategory)}
    />
    <Select
      id="theme-builder-preview-scene"
      label="Example"
      options={sceneOptions}
      value={workbench.sceneId}
      onchange={(event) => workbench.selectScene(event.currentTarget.value)}
    />
  </div>
  {#if workbench.preview.error !== null}
    <Callout variant="danger" title="Preview kept at the last valid revision">
      {workbench.preview.error.code}: {workbench.preview.error.message}
    </Callout>
  {/if}
  <iframe
    bind:this={frame}
    class="preview__frame"
    title="Theme preview"
    src={initialSrc}
    data-testid="theme-preview-frame"
  ></iframe>
</section>

<style>
  .preview {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  .preview__selectors {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 12px;
  }
  .preview__frame {
    display: block;
    width: 100%;
    height: 28rem;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-surface-canvas);
  }
</style>
