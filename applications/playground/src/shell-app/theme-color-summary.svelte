<script lang="ts">
  /*
   * What the color editor shows beside the controls (COR-263): the rendered color, its
   * authored space and alpha, the surface it sits on, where it falls against the sRGB and
   * Display P3 gamuts, and the roles that read it. Light and dark appear side by side for
   * comparison; reading one mode never touches the other mode's draft. Every swatch is drawn
   * from the authored value in its own space; nothing here converts or clamps the source.
   */
  import { Collapsible } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import type { CatalogueRow } from './theme-builder-catalogue.ts';
  import { colorsByMode, effectiveBackground } from './theme-color-editing.ts';
  import {
    authoredText,
    colorAlpha,
    compositeOver,
    gamutInfo,
    gamutSummary,
    spaceDefinition,
    type DtcgColor,
  } from './theme-color-model.ts';
  import { contextId, type ThemeEnvelope } from './theme-draft-types.ts';
  import { dependentsOf, type TokenDependents } from './theme-token-dependents.ts';
  import type { ThemePreviewContext } from './theme-preview-message.ts';

  type Props = {
    row: CatalogueRow;
    envelope: ThemeEnvelope;
    context: ThemePreviewContext;
    /** The color the controls currently show. */
    color: DtcgColor;
    /** Select a dependent in the catalogue. */
    onFollow: (path: string) => void;
  };
  let { row, envelope, context, color, onFollow }: Props = $props();

  const spaceLabel = $derived(spaceDefinition(color.colorSpace)?.label ?? color.colorSpace);
  const gamut = $derived(gamutInfo(color));
  const background = $derived(effectiveBackground(row, envelope, context));
  const modes = $derived(colorsByMode(envelope, row.path));
  const alpha = $derived(colorAlpha(color));

  // Dependents trace the whole theme, so they are computed only once the disclosure is open.
  let dependentsOpen = $state(false);
  let dependents = $state<TokenDependents | null>(null);
  $effect(() => {
    const target = envelope;
    const path = row.path;
    const id = contextId(context);
    untrack(() => (dependents = null));
    if (!dependentsOpen) return;
    const timer = setTimeout(() => (dependents = dependentsOf(target, id, path)), 0);
    return () => clearTimeout(timer);
  });
</script>

{#snippet swatch(value: DtcgColor | null, label: string)}
  <span class="swatch" role="img" aria-label={label}>
    <span
      class="swatch__fill"
      style:background={value === null ? 'transparent' : authoredText(value)}
    ></span>
  </span>
{/snippet}

<div class="summary" data-testid="color-summary">
  <div class="rendered">
    {@render swatch(color, `Rendered color of ${row.path}: ${authoredText(color)}`)}
    <code data-testid="color-authored-text">{authoredText(color)}</code>
  </div>

  <dl class="facts">
    <div>
      <dt>Authored color space</dt>
      <dd data-testid="color-space">{spaceLabel}</dd>
    </div>
    <div>
      <dt>Alpha</dt>
      <dd data-testid="color-alpha">{alpha}</dd>
    </div>
    <div>
      <dt>Gamut</dt>
      <dd data-testid="color-gamut">{gamutSummary(gamut)}</dd>
    </div>
    <div>
      <dt>Effective background</dt>
      <dd data-testid="color-background">
        {#if background === null}
          Unknown
        {:else}
          <span class="inline">
            {@render swatch(background.color, `Background ${background.path}`)}
            <code>{background.path}</code>
          </span>
          <span class="muted">
            {background.derived === 'paired' ? 'paired surface' : 'page surface'}
            {#if alpha < 1}· composited: <code>{compositeOver(color, background.color)}</code>{/if}
          </span>
        {/if}
      </dd>
    </div>
  </dl>

  {#if color.colorSpace !== 'srgb'}
    <p class="note" data-testid="color-preview-note">
      The swatch is drawn from the authored {spaceLabel} value. A display narrower than the value's gamut
      maps it for display only; the source value is not changed.
    </p>
  {/if}

  <section class="compare" aria-label="Light and dark compared">
    <h3>Light and dark</h3>
    <div class="compare__grid">
      {#each [['Light', modes.light], ['Dark', modes.dark]] as const as [label, value] (label)}
        <div class="compare__mode" data-testid={`compare-${label.toLowerCase()}`}>
          {@render swatch(value, `${label} value of ${row.path}`)}
          <span>
            <strong>{label}</strong>
            <code>{value === null ? 'not a literal color' : authoredText(value)}</code>
          </span>
        </div>
      {/each}
    </div>
  </section>

  <Collapsible trigger="Dependent roles" bind:open={dependentsOpen}>
    <div data-testid="color-dependents">
      {#if dependents === null}
        <p class="muted">Tracing dependents…</p>
      {:else if !dependents.ok}
        <p class="muted">{dependents.message}</p>
      {:else if dependents.paths.length === 0}
        <p class="muted">
          No alias or recipe reads this role in the {context.colorMode} color mode.
        </p>
      {:else}
        <ul>
          {#each dependents.paths as path (path)}
            <li>
              <button type="button" class="link" onclick={() => onFollow(path)}>{path}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </Collapsible>
</div>

<style>
  .summary {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .rendered,
  .inline,
  .compare__mode {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .swatch {
    flex: none;
    width: 2.5rem;
    height: 2.5rem;
    border: 1px solid var(--cinder-border-control);
    border-radius: var(--cinder-radius-md);
    background-image: conic-gradient(#999 25%, #fff 0 50%, #999 0 75%, #fff 0);
    background-size: 10px 10px;
    overflow: hidden;
  }
  .swatch__fill {
    display: block;
    width: 100%;
    height: 100%;
  }
  .inline .swatch {
    width: 1.25rem;
    height: 1.25rem;
  }
  .facts {
    display: grid;
    gap: 4px;
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
  .facts > div {
    display: grid;
    grid-template-columns: minmax(8rem, 11rem) minmax(0, 1fr);
    gap: 8px;
  }
  dt,
  .muted {
    color: var(--cinder-text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  h3 {
    margin: 0 0 6px;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
  }
  .compare__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 8px;
  }
  .compare__mode span {
    display: grid;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .note,
  p {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
  ul {
    margin: 0;
    padding-inline-start: 1.25rem;
    font-size: var(--cinder-text-sm);
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--cinder-accent-text);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }
  @media (max-width: 479.98px) {
    .facts > div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
  }
  @media (forced-colors: active) {
    .link:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: 3px;
    }
  }
</style>
