<script lang="ts">
  /*
   * The live preview beside a foundation editor (COR-489). It draws the token's last-valid
   * committed value, never the text being typed, so a partial or invalid entry cannot move
   * it. A member of the spacing or radius scale is shown among its siblings in scale order,
   * under the Cinder names; everything else gets one sample of its own kind. Sizes are
   * clamped so a very large value stays inside the pane.
   */
  import { AUTHORING_CATALOGUE } from '@lostgradient/cinder/tokens/runtime';

  import type { CatalogueRow } from './theme-builder-catalogue.ts';
  import ThemeFoundationScalePreview from './theme-foundation-scale-preview.svelte';
  import { cssLengthToPx, resolveCssValue } from './theme-foundation-values.ts';

  type Props = { row: CatalogueRow; values: ReadonlyMap<string, string> };
  let { row, values }: Props = $props();

  const MAX_BAR = 192;
  const MAX_SAMPLE = 48;

  const css = $derived(resolveCssValue(values, row.cssProperty));
  const px = $derived(cssLengthToPx(css));
  const scale = $derived(
    Object.entries(AUTHORING_CATALOGUE.scales).find(([, members]) => members.includes(row.path)),
  );
  const clamp = (value: number | undefined, max: number) => Math.max(0, Math.min(value ?? 0, max));
</script>

<figure class="preview" aria-label={`Preview of ${row.name}`} data-testid="token-preview">
  {#if scale !== undefined}
    <ThemeFoundationScalePreview scale={scale[0]} {values} current={row.path} />
  {:else if row.profile?.id === 'font-size' && px !== undefined}
    <p class="sample" style={`font-size: ${clamp(px, MAX_SAMPLE)}px;`}>Aa The quick brown fox</p>
  {:else if row.profile?.id === 'font-weight' && css !== undefined}
    <p class="sample" style={`font-weight: ${css};`}>Aa The quick brown fox</p>
  {:else if row.profile?.id === 'line-height' && css !== undefined}
    <p class="sample sample--lines" style={`line-height: ${css};`}>
      Two lines of sample text show the line height between them.
    </p>
  {:else if row.profile?.id === 'opacity' && css !== undefined}
    <span class="swatch" style={`opacity: ${css};`} aria-hidden="true"></span>
  {:else if row.type === 'duration' && css !== undefined}
    <div class="track" aria-hidden="true">
      <span
        class="track__fill"
        style={`inline-size: ${Math.min(100, (Number.parseFloat(css) / (css.endsWith('ms') ? 2000 : 2)) * 100)}%;`}
      ></span>
    </div>
  {:else if px !== undefined}
    <span class="bar" style={`inline-size: ${clamp(Math.abs(px), MAX_BAR)}px;`} aria-hidden="true"
    ></span>
  {/if}
  <figcaption>
    Draft <code data-testid="preview-value">{css ?? 'Not evaluated yet'}</code>
  </figcaption>
</figure>

<style>
  .preview {
    display: grid;
    gap: 6px;
    margin: 0;
    min-width: 0;
    font-size: var(--cinder-text-sm);
  }
  .bar {
    display: block;
    block-size: 12px;
    background: var(--cinder-text-muted);
    border-radius: 2px;
  }
  .sample {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .swatch {
    display: block;
    inline-size: 48px;
    block-size: 24px;
    background: var(--cinder-text-default);
    border-radius: 2px;
  }
  .track {
    block-size: 8px;
    background: var(--cinder-border-muted);
    border-radius: 4px;
  }
  .track__fill {
    display: block;
    block-size: 100%;
    background: var(--cinder-text-muted);
    border-radius: 4px;
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
</style>
