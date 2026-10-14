<script lang="ts">
  /*
   * The theme builder workbench shell: a persistent toolbar, a category rail, the
   * catalogue and editor slot, the preview slot, and the checks slot. At 1200px and wider
   * the preview and checks sit beside the editor; from 768px they sit in a row below it;
   * below 768px the Edit, Preview, and Checks panes become tab panels that stay mounted
   * (so the preview iframe keeps its state) and restore their scroll position when shown
   * again. Theme values never style this chrome: they reach only the preview iframe.
   *
   * COR-490, COR-489, COR-263, and COR-488 plug in through `state` (the typed store) and
   * the `editor` and `checks` snippets.
   */
  import { Tabs } from '@lostgradient/cinder';
  import { onMount, tick, type Snippet } from 'svelte';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import ThemeChecksPanel from './theme-checks-panel.svelte';
  import ThemeFoundationsView from './theme-foundations-view.svelte';
  import ThemeWorkbenchCatalogue from './theme-workbench-catalogue.svelte';
  import ThemeWorkbenchDraftBar from './theme-workbench-draft-bar.svelte';
  import ThemeWorkbenchLibrary from './theme-workbench-library.svelte';
  import ThemeWorkbenchLegacyNotice from './theme-workbench-legacy-notice.svelte';
  import ThemeWorkbenchEditor from './theme-workbench-editor.svelte';
  import { observeLayout, type WorkbenchLayout } from './theme-workbench-layout.ts';
  import ThemeWorkbenchPreview from './theme-workbench-preview.svelte';
  import ThemeWorkbenchRail from './theme-workbench-rail.svelte';
  import { ThemeWorkbenchState, type WorkbenchPane } from './theme-workbench-state.svelte.ts';
  import ThemeWorkbenchToolbar from './theme-workbench-toolbar.svelte';

  type Props = {
    workbench?: ThemeWorkbenchState;
    /** The selected token's value editor (COR-489, COR-263, COR-488). */
    editor?: Snippet<[ThemeWorkbenchState]>;
    /** Accessibility findings (COR-259, COR-487). */
    checks?: Snippet<[ThemeWorkbenchState]>;
    /** Where the preview iframe loads from; tests point it at a static fixture. */
    previewPath?: string;
    /** The draft, history and storage controller (COR-490); without it the shell is inert. */
    controller?: ThemeBuilderController;
  };
  let {
    workbench = new ThemeWorkbenchState(),
    editor,
    checks,
    previewPath,
    controller,
  }: Props = $props();

  let layout = $state<WorkbenchLayout>('desktop');
  let announcement = $state('');
  let panes: Partial<Record<WorkbenchPane, HTMLElement>> = {};

  const PANE_LABELS: Record<WorkbenchPane, string> = {
    edit: 'Edit',
    preview: 'Preview',
    checks: 'Checks',
  };
  const compact = $derived(layout === 'mobile');

  onMount(() => {
    announcement = 'Theme builder';
    if (controller !== undefined && !controller.ready) void controller.start();
    const stop = observeLayout(window, (next) => {
      layout = next;
    });
    return () => {
      stop();
      controller?.stop();
    };
  });

  function remember(pane: WorkbenchPane): void {
    workbench.scrollByPane[pane] = window.scrollY;
    for (const region of panes[pane]?.querySelectorAll<HTMLElement>('[data-scroll-region]') ?? []) {
      workbench.scrollByRegion[region.dataset['scrollRegion']!] = region.scrollTop;
    }
  }

  async function restore(pane: WorkbenchPane): Promise<void> {
    await tick();
    window.scrollTo({ top: workbench.scrollByPane[pane], behavior: 'instant' });
    for (const region of panes[pane]?.querySelectorAll<HTMLElement>('[data-scroll-region]') ?? []) {
      region.scrollTop = workbench.scrollByRegion[region.dataset['scrollRegion']!] ?? 0;
    }
  }

  function switchPane(next: string): void {
    const pane = next as WorkbenchPane;
    if (pane === workbench.pane) return;
    remember(workbench.pane);
    workbench.setPane(pane);
    announcement = `${PANE_LABELS[pane]} tab selected`;
    void restore(pane);
  }

  function focusHeading(event: MouseEvent): void {
    event.preventDefault();
    document.getElementById('theme-builder-heading')?.focus();
  }

  function registerPane(node: HTMLElement, name: WorkbenchPane) {
    panes[name] = node;
    return () => {
      delete panes[name];
    };
  }
</script>

<div class="workbench" data-layout={layout} data-testid="theme-workbench">
  <a class="skip-link" href="#theme-builder-heading" onclick={focusHeading}>
    Skip to the theme builder
  </a>
  <div class="sr-only" aria-live="polite" data-testid="workbench-announcer">
    {controller?.announcement || announcement}
  </div>

  <ThemeWorkbenchToolbar {workbench} />
  {#if controller !== undefined}
    <ThemeWorkbenchLibrary {controller} />
    <ThemeWorkbenchDraftBar {controller} {workbench} />
  {/if}
  <ThemeWorkbenchLegacyNotice />

  {#if compact}
    <Tabs value={workbench.pane} onValueChange={switchPane}>
      <Tabs.List label="Workbench sections">
        {#each Object.entries(PANE_LABELS) as [value, label] (value)}
          <Tabs.Trigger
            {value}
            id={`theme-builder-tab-${value}`}
            controls={`theme-builder-pane-${value}`}
          >
            {label}
          </Tabs.Trigger>
        {/each}
      </Tabs.List>
    </Tabs>
  {/if}

  <div class="body">
    <div
      class="pane pane--edit"
      id="theme-builder-pane-edit"
      {@attach (node) => registerPane(node, 'edit')}
      role={compact ? 'tabpanel' : 'region'}
      aria-labelledby={compact ? 'theme-builder-tab-edit' : undefined}
      aria-label={compact ? undefined : 'Edit'}
      hidden={compact && workbench.pane !== 'edit'}
    >
      <ThemeWorkbenchRail {workbench} />
      <div class="main">
        <ThemeWorkbenchCatalogue {workbench} {layout} {controller} />
        {#if controller !== undefined && workbench.groupId === 'foundations'}
          <ThemeFoundationsView {controller} {workbench} />
        {/if}
        <ThemeWorkbenchEditor {workbench} {editor} {controller} />
      </div>
    </div>

    <div class="side">
      <div
        class="pane pane--card"
        id="theme-builder-pane-preview"
        {@attach (node) => registerPane(node, 'preview')}
        role={compact ? 'tabpanel' : 'region'}
        aria-labelledby={compact ? 'theme-builder-tab-preview' : undefined}
        aria-label={compact ? undefined : 'Preview'}
        hidden={compact && workbench.pane !== 'preview'}
      >
        <ThemeWorkbenchPreview {workbench} {previewPath} />
      </div>
      <div
        class="pane pane--card"
        id="theme-builder-pane-checks"
        {@attach (node) => registerPane(node, 'checks')}
        role={compact ? 'tabpanel' : 'region'}
        aria-labelledby={compact ? 'theme-builder-tab-checks' : undefined}
        aria-label={compact ? undefined : 'Checks'}
        hidden={compact && workbench.pane !== 'checks'}
      >
        <section aria-labelledby="checks-heading" class="checks">
          <h2 id="checks-heading">Checks</h2>
          {#if checks !== undefined}
            {@render checks(workbench)}
          {:else if controller !== undefined}
            <ThemeChecksPanel {workbench} {controller} />
          {:else}
            <p class="muted">
              {workbench.findingsCount === 0
                ? 'No findings. Checks run once a theme is open.'
                : `${workbench.findingsCount} findings.`}
            </p>
          {/if}
        </section>
      </div>
    </div>
  </div>
</div>

<style>
  .workbench {
    display: grid;
    gap: 16px;
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    padding: 16px;
    color: var(--cinder-text-default);
  }
  .workbench > :global(*) {
    min-width: 0;
  }
  .body,
  .side,
  .pane--edit,
  .main {
    display: grid;
    gap: 16px;
    min-width: 0;
  }
  .body,
  .pane--edit {
    grid-template-columns: minmax(0, 1fr);
  }
  .main {
    align-content: start;
  }
  .pane[hidden] {
    display: none;
  }
  .pane--card {
    padding: 12px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-surface-raised);
  }
  .checks {
    display: grid;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  .muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  .skip-link {
    position: absolute;
    inset-inline-start: 8px;
    inset-block-start: -4rem;
    z-index: 10;
    padding: 8px 12px;
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-surface-raised);
    color: var(--cinder-text-default);
  }
  .skip-link:focus {
    inset-block-start: 8px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* 768px through 1199px: a 176px rail beside the main region; preview and checks in a row below. */
  @media (min-width: 768px) {
    .pane--edit {
      grid-template-columns: 176px minmax(0, 1fr);
    }
    .side {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
    }
  }
  /* 1200px and wider: a 208px rail, a flexible editor, and a 360px preview and checks column. */
  @media (min-width: 1200px) {
    .body {
      grid-template-columns: minmax(0, 1fr) 360px;
      align-items: start;
    }
    .pane--edit {
      grid-template-columns: 208px minmax(0, 1fr);
    }
    .side {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
