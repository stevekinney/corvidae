<script lang="ts">
  /*
   * The persistent toolbar: theme name, the concrete context (color mode and motion),
   * the Export action, and the status area (save state, findings, preview revision).
   * It stays visible on every pane. Export is a placeholder until COR-486 supplies it.
   */
  import { Button, Callout, Select } from '@lostgradient/cinder';

  import {
    THEME_PREVIEW_COLOR_MODES,
    THEME_PREVIEW_MOTIONS,
    type ThemePreviewColorMode,
    type ThemePreviewMotion,
  } from './theme-preview-message.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = { workbench: ThemeWorkbenchState };
  let { workbench }: Props = $props();

  const COLOR_MODE_LABELS: Record<ThemePreviewColorMode, string> = {
    light: 'Light',
    dark: 'Dark',
  };
  const MOTION_LABELS: Record<ThemePreviewMotion, string> = {
    default: 'Default motion',
    reduced: 'Reduced motion',
    'forced-reduced-motion': 'Forced reduced motion',
  };
  const colorModeOptions = THEME_PREVIEW_COLOR_MODES.map((value) => ({
    value,
    label: COLOR_MODE_LABELS[value],
  }));
  const motionOptions = THEME_PREVIEW_MOTIONS.map((value) => ({
    value,
    label: MOTION_LABELS[value],
  }));

  const findingsLabel = $derived(
    `${workbench.findingsCount} ${workbench.findingsCount === 1 ? 'finding' : 'findings'}`,
  );
</script>

<header class="toolbar" aria-label="Theme builder toolbar">
  <div class="toolbar__title">
    <h1 id="theme-builder-heading" tabindex="-1">Theme builder</h1>
    <p class="toolbar__theme">
      <span class="toolbar__label">Theme</span>
      <span data-testid="theme-name">{workbench.themeName}</span>
    </p>
  </div>

  <div class="toolbar__controls" role="group" aria-label="Preview context">
    <div class="toolbar__field">
      <Select
        id="theme-builder-color-mode"
        label="Color mode"
        options={colorModeOptions}
        value={workbench.context.colorMode}
        onchange={(event) =>
          workbench.setContext({
            colorMode: event.currentTarget.value as ThemePreviewColorMode,
            motion: workbench.context.motion,
          })}
      />
    </div>
    <div class="toolbar__field">
      <Select
        id="theme-builder-motion"
        label="Motion"
        options={motionOptions}
        value={workbench.context.motion}
        onchange={(event) =>
          workbench.setContext({
            colorMode: workbench.context.colorMode,
            motion: event.currentTarget.value as ThemePreviewMotion,
          })}
      />
    </div>
    <Button
      label="Export"
      variant="secondary"
      disabled
      aria-describedby="theme-builder-export-note"
    />
    <span id="theme-builder-export-note" class="sr-only">
      Export arrives with theme import and export.
    </span>
  </div>

  <ul class="toolbar__status" aria-label="Draft status" data-testid="workbench-status">
    <li data-testid="save-state">
      {workbench.saveStatus === 'saved' ? 'Saved locally' : 'Unsaved locally'}
    </li>
    <li data-testid="findings-count">{findingsLabel}</li>
    <li data-testid="preview-revision">
      Preview revision {workbench.revision}{workbench.previewIsStale ? ' (updating)' : ''}
    </li>
  </ul>

  {#if workbench.storageNotice?.notice}
    <div class="toolbar__notice" data-testid="storage-notice">
      <Callout variant="warning" title="Unsaved locally">
        {workbench.storageNotice.notice}
      </Callout>
    </div>
  {/if}
</header>

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px 16px;
    min-width: 0;
  }
  .toolbar__title {
    flex: 1 1 14rem;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: var(--cinder-font-semibold);
  }
  h1:focus {
    outline: none;
  }
  .toolbar__theme {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
  .toolbar__label {
    margin-inline-end: 0.5ch;
  }
  .toolbar__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
    min-width: 0;
  }
  .toolbar__field {
    flex: 1 1 10rem;
    max-width: 14rem;
    min-width: 0;
  }
  .toolbar__status {
    display: flex;
    flex-wrap: wrap;
    flex: 1 1 100%;
    gap: 4px 16px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  .toolbar__notice {
    flex: 1 1 100%;
    min-width: 0;
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
  @media (max-width: 767.98px) {
    .toolbar__controls {
      width: 100%;
    }
    .toolbar__field {
      max-width: none;
    }
  }
  @media (max-width: 479.98px) {
    .toolbar__field {
      flex-basis: 100%;
    }
  }
</style>
