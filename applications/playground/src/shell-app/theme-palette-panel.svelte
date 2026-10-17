<script lang="ts">
  /*
   * Create palette (COR-263). The user gives a seed color and picks a family; the panel
   * proposes an OKLCH value for every role in that family, for the light and the dark color
   * mode separately, against the immutable shipped baseline. Nothing is committed until Apply,
   * and Apply writes only the selected color modes as one undoable transaction. The preview
   * frame shows the proposal in the active color mode before Apply. Applying a palette makes
   * no accessibility claim; the checks still run afterwards.
   */
  import { Button, Callout, Checkbox, Input, Select } from '@lostgradient/cinder';
  import { onDestroy, untrack } from 'svelte';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import { CHROMA_GRID_VERSION, type OutputGamut } from './theme-chroma-grid.ts';
  import ThemePaletteRoles from './theme-palette-roles.svelte';
  import {
    applyPaletteState,
    buildPaletteProposal,
    PALETTE_COLOR_MODES,
    PALETTE_FAMILY_OPTIONS,
    selectedRoles,
    type PaletteColorMode,
  } from './theme-palette-proposal.ts';
  import { themePreviewScenesInCategory } from './theme-preview-scenes.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';
  import type { PaletteFamily } from '@lostgradient/cinder/tokens/runtime';

  type Props = {
    controller: ThemeBuilderController;
    workbench: ThemeWorkbenchState;
    onClose: () => void;
  };
  let { controller, workbench, onClose }: Props = $props();

  let seed = $state('');
  let family = $state<PaletteFamily>('accent');
  let gamut = $state<OutputGamut>('srgb');
  let selectedModes = $state<ReadonlySet<PaletteColorMode>>(new Set(PALETTE_COLOR_MODES));
  let included = $state<ReadonlySet<string>>(new Set());
  let previewing = false;
  let applying = $state(false);
  let message = $state<string | null>(null);

  const envelope = $derived(controller.draft?.envelope ?? null);
  const result = $derived(
    envelope === null || seed.trim() === ''
      ? null
      : buildPaletteProposal({ seed, family, gamut, envelope, locked: controller.lockedPaths }),
  );
  const proposal = $derived(result?.ok ? result.proposal : null);
  const seedError = $derived(result !== null && !result.ok ? result.message : undefined);
  const selection = $derived({ modes: selectedModes, includeOverrides: included });
  const chosen = $derived(proposal === null ? [] : selectedRoles(proposal, selection));
  const overrideCount = $derived(
    proposal === null
      ? 0
      : PALETTE_COLOR_MODES.flatMap((mode) => proposal.modes[mode]).filter(
          (role) => role.override !== null && role.skipped === null,
        ).length,
  );
  const familyLabel = $derived(
    PALETTE_FAMILY_OPTIONS.find((option) => option.id === family)?.label,
  );

  // The preview shows the proposal in the active color mode; it ends when the panel does.
  $effect(() => {
    void workbench.context.colorMode;
    const shown = proposal !== null && chosen.length > 0 ? proposal : null;
    untrack(() => {
      if (shown !== null && envelope !== null) {
        previewing = true;
        void controller.previewState(applyPaletteState(envelope, shown, selection));
      } else if (previewing) {
        previewing = false;
        void controller.previewState(null);
      }
    });
  });

  onDestroy(() => {
    if (previewing) void controller.previewState(null);
  });

  function toggle<T>(set: ReadonlySet<T>, value: T, on: boolean): ReadonlySet<T> {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  }

  function showScene(category: 'Components' | 'Application'): void {
    const first = themePreviewScenesInCategory(category)[0];
    if (first !== undefined) workbench.selectScene(first.id);
    workbench.setPane('preview');
  }

  async function apply(): Promise<void> {
    if (envelope === null || proposal === null || chosen.length === 0 || applying) return;
    applying = true;
    previewing = false;
    const modes = PALETTE_COLOR_MODES.filter((mode) => selectedModes.has(mode));
    const outcome = await controller.commit({
      kind: 'edit',
      label: `Apply ${familyLabel} palette (${modes.join(', ')})`,
      state: applyPaletteState(envelope, proposal, selection),
    });
    applying = false;
    if (!outcome.ok) {
      message = outcome.message;
      return;
    }
    controller.announcement = `Applied the ${familyLabel} palette to ${chosen.length} roles in ${modes.join(' and ')}. Accessibility checks have not been run on it.`;
    onClose();
  }

  function cancel(): void {
    if (previewing) {
      previewing = false;
      void controller.previewState(null);
    }
    controller.announcement = 'Palette proposal discarded.';
    onClose();
  }
</script>

<section class="palette" aria-labelledby="palette-heading" data-testid="palette-panel">
  <h3 id="palette-heading">Create palette</h3>
  <p class="note">
    Generate a family from one seed color. The proposal is built from the shipped baseline, so your
    current overrides never move an offset or an anchor. Nothing changes until you apply.
  </p>

  <div class="inputs">
    <Input
      id="palette-seed"
      label="Seed color"
      description="Any literal color, for example #3366ff or oklch(0.6 0.2 260)."
      value={seed}
      {...seedError === undefined ? {} : { error: seedError }}
      onValueChange={(next) => (seed = next)}
    />
    <Select
      id="palette-family"
      label="Family"
      options={PALETTE_FAMILY_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
      value={family}
      onchange={(event) => (family = event.currentTarget.value as PaletteFamily)}
    />
    <Select
      id="palette-gamut"
      label="Output gamut"
      options={[
        { value: 'srgb', label: 'sRGB' },
        { value: 'display-p3', label: 'Display P3' },
      ]}
      value={gamut}
      onchange={(event) => (gamut = event.currentTarget.value as OutputGamut)}
    />
  </div>

  <p class="note" data-testid="palette-algorithm">
    Proposals are OKLCH values. Chroma is reduced into {gamut === 'srgb' ? 'sRGB' : 'Display P3'} on a
    descending 101-step grid ({CHROMA_GRID_VERSION}); no channel is clipped. Each role keeps its
    existing alpha.
  </p>

  {#if proposal !== null}
    {#each PALETTE_COLOR_MODES as mode (mode)}
      <section class="mode" aria-labelledby={`palette-mode-${mode}`}>
        <div class="mode__header">
          <h4 id={`palette-mode-${mode}`}>{mode === 'light' ? 'Light' : 'Dark'} mode</h4>
          <Checkbox
            id={`palette-apply-${mode}`}
            label={`Apply to ${mode} mode`}
            checked={selectedModes.has(mode)}
            onValueChange={(on) => (selectedModes = toggle(selectedModes, mode, on))}
          />
        </div>
        <ThemePaletteRoles
          roles={proposal.modes[mode]}
          {mode}
          locked={controller.lockedPaths}
          {included}
          onLock={(path, on) => void controller.setLocked(path, on)}
          onInclude={(key, on) => (included = toggle(included, key, on))}
        />
      </section>
    {/each}

    {#if overrideCount > 0}
      <Callout variant="warning" title="Existing overrides">
        Some roles already carry an explicit override. They are listed above and are replaced only
        when you include them.
      </Callout>
    {/if}

    <div class="preview-actions" role="group" aria-label="Preview the proposal">
      <Button
        label="Preview Components"
        variant="secondary"
        onclick={() => showScene('Components')}
      />
      <Button
        label="Preview Application"
        variant="secondary"
        onclick={() => showScene('Application')}
      />
    </div>
    <Callout variant="info" title="No accessibility claim">
      Applying a palette does not check or assert accessibility. Run the checks after you apply.
    </Callout>
  {/if}

  {#if message !== null}
    <p class="error" role="alert">{message}</p>
  {/if}

  <div class="actions">
    <Button
      label="Apply palette"
      variant="primary"
      disabled={chosen.length === 0 || applying}
      onclick={() => void apply()}
    />
    <Button label="Cancel" variant="secondary" onclick={cancel} />
  </div>
  <p class="count" aria-live="polite" data-testid="palette-count">
    {chosen.length}
    {chosen.length === 1 ? 'role' : 'roles'} will change.
  </p>
</section>

<style>
  .palette,
  .mode {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .palette {
    padding: 12px;
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }
  h3,
  h4 {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  h4 {
    font-size: var(--cinder-text-sm);
  }
  .note,
  .count {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
  .error {
    margin: 0;
    color: var(--cinder-status-danger-text);
    font-size: var(--cinder-text-sm);
  }
  .inputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 12px;
  }
  .mode__header,
  .actions,
  .preview-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .actions,
  .preview-actions {
    justify-content: flex-start;
  }
</style>
