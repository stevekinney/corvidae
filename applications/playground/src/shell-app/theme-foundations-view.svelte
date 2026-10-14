<script lang="ts">
  /*
   * The Foundations category view (COR-489): the spacing and radius scales drawn in order with
   * the Compact, Standard and Comfortable presets under each, the typography specimen, and a
   * Reset control for each foundation family. It reads the last-valid committed values, so a
   * half-typed entry in an editor never moves anything here.
   */
  import { Button } from '@lostgradient/cinder';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import { editableState } from './theme-draft-types.ts';
  import { resetState } from './theme-draft.ts';
  import ThemeFoundationScalePreview from './theme-foundation-scale-preview.svelte';
  import { PRESET_SCALES } from './theme-scale-presets.ts';
  import ThemeScalePresets from './theme-scale-presets.svelte';
  import ThemeTypographySpecimen from './theme-typography-specimen.svelte';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = { controller: ThemeBuilderController; workbench: ThemeWorkbenchState };
  let { controller, workbench }: Props = $props();

  // Each family resets every override under its token-path prefixes as one transaction.
  const FAMILIES: readonly { label: string; prefixes: readonly string[] }[] = [
    { label: 'spacing', prefixes: ['space'] },
    { label: 'radius', prefixes: ['radius'] },
    { label: 'typography', prefixes: ['font', 'leading', 'tracking', 'type'] },
    { label: 'motion', prefixes: ['motion', 'ease'] },
  ];

  async function resetFamily(family: (typeof FAMILIES)[number]): Promise<void> {
    const draft = controller.draft;
    if (draft === null) return;
    let state = editableState(draft.envelope);
    for (const prefix of family.prefixes) state = resetState(state, { kind: 'category', prefix });
    await controller.commit({ kind: 'reset', label: `Reset ${family.label}`, state });
  }
</script>

<section class="foundations" aria-labelledby="foundations-heading" data-testid="foundations-view">
  <h2 id="foundations-heading">Foundations</h2>

  {#each PRESET_SCALES as entry (entry.scale)}
    <div class="scale" data-testid={`foundations-${entry.scale}`}>
      <h3>{entry.label} scale</h3>
      <ThemeFoundationScalePreview scale={entry.scale} values={controller.draftValues} />
      <ThemeScalePresets {controller} {workbench} scale={entry.scale} label={entry.label} />
    </div>
  {/each}

  <ThemeTypographySpecimen {controller} {workbench} />

  <div class="resets" role="group" aria-label="Reset a foundation family">
    {#each FAMILIES as family (family.label)}
      <Button
        label={`Reset ${family.label}`}
        variant="secondary"
        onclick={() => void resetFamily(family)}
      />
    {/each}
  </div>
</section>

<style>
  .foundations,
  .scale {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .foundations {
    padding: 12px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
  h2,
  h3 {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  .resets {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
