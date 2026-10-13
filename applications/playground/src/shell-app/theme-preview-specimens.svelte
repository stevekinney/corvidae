<script lang="ts">
  /*
   * The Foundations scene: token scales and type specimens, drawn only from the public
   * `--cinder-*` surface so every theme edit has something to show. These elements carry
   * no interaction, so the scene manifest marks the interaction states not applicable.
   */
  const colorSwatches = [
    { label: 'Canvas', variable: '--cinder-surface-canvas' },
    { label: 'Raised', variable: '--cinder-surface-raised' },
    { label: 'Inset', variable: '--cinder-surface-inset' },
    { label: 'Accent', variable: '--cinder-accent-solid' },
    { label: 'Info', variable: '--cinder-status-info-text' },
    { label: 'Success', variable: '--cinder-status-success-text' },
    { label: 'Warning', variable: '--cinder-status-warning-text' },
    { label: 'Danger', variable: '--cinder-status-danger-text' },
  ];
  const spacingSteps = ['2', '3', '4', '6', '8', '12'];
  const radii = ['sm', 'md', 'lg', 'full'];
  const typeSizes = ['xs', 'sm', 'base', 'lg', 'xl', '2xl'];
  const shadows = ['sm', 'md', 'lg'];
</script>

<div class="specimens">
  <section aria-labelledby="specimen-color">
    <h2 id="specimen-color">Color</h2>
    <ul class="swatches">
      {#each colorSwatches as swatch (swatch.variable)}
        <li>
          <span class="swatch" style:background={`var(${swatch.variable})`}></span>
          <span>{swatch.label}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section aria-labelledby="specimen-type">
    <h2 id="specimen-type">Type</h2>
    {#each typeSizes as size (size)}
      <p style:font-size={`var(--cinder-text-${size})`}>Text {size}: sphinx of black quartz</p>
    {/each}
    <p style:font-family="var(--cinder-font-mono)">Monospace: 0123456789</p>
    <p style:font-weight="var(--cinder-font-bold)">Bold weight</p>
  </section>

  <section aria-labelledby="specimen-space">
    <h2 id="specimen-space">Spacing</h2>
    {#each spacingSteps as step (step)}
      <div class="space-row">
        <span>space-{step}</span>
        <span class="space-bar" style:width={`var(--cinder-space-${step})`}></span>
      </div>
    {/each}
  </section>

  <section aria-labelledby="specimen-shape">
    <h2 id="specimen-shape">Radius and elevation</h2>
    <div class="shapes">
      {#each radii as radius (radius)}
        <span class="shape" style:border-radius={`var(--cinder-radius-${radius})`}>{radius}</span>
      {/each}
      {#each shadows as shadow (shadow)}
        <span class="shape shadowed" style:box-shadow={`var(--cinder-shadow-${shadow})`}>
          {shadow}
        </span>
      {/each}
    </div>
  </section>
</div>

<style>
  .specimens {
    display: grid;
    gap: var(--cinder-space-6);
  }
  h2 {
    margin: 0 0 var(--cinder-space-3);
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
    color: var(--cinder-text-muted);
  }
  p {
    margin: 0 0 var(--cinder-space-2);
    color: var(--cinder-text-default);
  }
  .swatches {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
    gap: var(--cinder-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--cinder-text-xs);
  }
  .swatch {
    display: block;
    height: 2.5rem;
    margin-block-end: var(--cinder-space-2);
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
  .space-row {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
    margin-block-end: var(--cinder-space-2);
    font-size: var(--cinder-text-xs);
  }
  .space-row > span:first-child {
    min-width: 5rem;
  }
  .space-bar {
    display: block;
    height: 0.75rem;
    background: var(--cinder-accent-solid);
  }
  .shapes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-4);
  }
  .shape {
    display: grid;
    place-items: center;
    width: 4rem;
    height: 4rem;
    border: 1px solid var(--cinder-border-control);
    background: var(--cinder-surface-raised);
    font-size: var(--cinder-text-xs);
  }
  .shadowed {
    border-color: transparent;
  }
</style>
