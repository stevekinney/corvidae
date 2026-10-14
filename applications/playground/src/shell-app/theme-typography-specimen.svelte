<script lang="ts">
  /*
   * The typography specimen (COR-489): the two shipped families, base and monospace, each
   * with its complete ordered fallback stack beside a sample set in it, and the size, weight,
   * letter spacing and line height each sample uses. Heading samples inherit the base family:
   * Cinder has no heading-family token and none is invented here. Only fonts the browser
   * already has are drawn; a named family it cannot find is flagged environment-dependent.
   */
  import { catalogueRowByPath } from './theme-builder-catalogue.ts';
  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import {
    browserFontProbe,
    ENVIRONMENT_DEPENDENT_NOTICE,
    environmentDependentFamilies,
    type FontProbe,
  } from './theme-font-availability.ts';
  import { resolveCssValue } from './theme-foundation-values.ts';
  import { literalValueOf } from './theme-token-edit.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = {
    controller: ThemeBuilderController;
    workbench: ThemeWorkbenchState;
    probe?: FontProbe;
  };
  let { controller, workbench, probe = browserFontProbe() }: Props = $props();

  const css = (path: string): string =>
    resolveCssValue(controller.draftValues, catalogueRowByPath(path)?.cssProperty ?? '') ?? '';

  type Sample = {
    id: string;
    label: string;
    family: 'font.sans' | 'font.mono';
    text: string;
    size: string;
    weight: string;
    leading: string;
    tracking: string;
  };

  const SAMPLES: readonly Sample[] = [
    {
      id: 'heading-1',
      label: 'Heading 1',
      family: 'font.sans',
      text: 'Heading one',
      size: 'font.size.4xl',
      weight: 'font.bold',
      leading: 'leading.tight',
      tracking: 'tracking.tight',
    },
    {
      id: 'heading-2',
      label: 'Heading 2',
      family: 'font.sans',
      text: 'Heading two',
      size: 'font.size.2xl',
      weight: 'font.semibold',
      leading: 'leading.snug',
      tracking: 'tracking.normal',
    },
    {
      id: 'body',
      label: 'Body',
      family: 'font.sans',
      text: 'Body text sets the rhythm of a page. The quick brown fox jumps over the lazy dog.',
      size: 'font.size.base',
      weight: 'font.normal',
      leading: 'leading.normal',
      tracking: 'tracking.normal',
    },
    {
      id: 'code',
      label: 'Code',
      family: 'font.mono',
      text: 'const answer = 42; // monospace',
      size: 'font.size.sm',
      weight: 'font.normal',
      leading: 'leading.normal',
      tracking: 'tracking.normal',
    },
  ];

  const stacks = $derived(
    (['font.sans', 'font.mono'] as const).map((path) => {
      const envelope = controller.draft?.envelope;
      const literal =
        envelope === undefined ? undefined : literalValueOf(envelope, workbench.context, path);
      const stack =
        typeof literal === 'string' || Array.isArray(literal) ? (literal as string | string[]) : [];
      return {
        path,
        label: path === 'font.sans' ? 'Base family' : 'Monospace family',
        stack: typeof stack === 'string' ? [stack] : stack,
        unavailable: environmentDependentFamilies(stack, probe),
        css: css(path),
      };
    }),
  );
</script>

<section
  class="specimen"
  aria-labelledby="typography-specimen-heading"
  data-testid="typography-specimen"
>
  <h3 id="typography-specimen-heading">Typography specimen</h3>
  <p class="muted">
    Headings use the base family; Cinder has no separate heading font. Previews use fonts already
    available in this browser and nothing is downloaded.
  </p>

  {#each stacks as entry (entry.path)}
    <div class="stack" data-testid={`stack-${entry.path}`}>
      <h4>{entry.label} <code>{entry.path}</code></h4>
      <ol class="stack__list" aria-label={`${entry.label} fallback order`}>
        {#each entry.stack as family, index (index)}
          <li>{family}</li>
        {/each}
      </ol>
      {#if entry.unavailable.length > 0}
        <p class="muted" data-testid={`stack-${entry.path}-notice`}>
          {ENVIRONMENT_DEPENDENT_NOTICE} Not found here: {entry.unavailable.join(', ')}.
        </p>
      {/if}
    </div>
  {/each}

  {#each SAMPLES as sample (sample.id)}
    <div class="sample" data-testid={`sample-${sample.id}`}>
      <p
        class="sample__text"
        style={`font-family: ${css(sample.family)}; font-size: ${css(sample.size)}; font-weight: ${css(sample.weight)}; line-height: ${css(sample.leading)}; letter-spacing: ${css(sample.tracking)};`}
        aria-label={`${sample.label} specimen`}
      >
        {sample.text}
      </p>
      <p class="muted">
        {sample.label}: {sample.family === 'font.sans' ? 'base' : 'monospace'} family, size
        {css(sample.size)}, weight {css(sample.weight)}, letter spacing {css(sample.tracking)}, line
        height {css(sample.leading)}.
      </p>
    </div>
  {/each}
</section>

<style>
  .specimen,
  .stack,
  .sample {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  h3,
  h4,
  p {
    margin: 0;
  }
  h3 {
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  h4 {
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
  }
  .muted {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  .stack__list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin: 0;
    padding-inline-start: 1.25rem;
    font-size: var(--cinder-text-sm);
  }
  .sample__text {
    overflow-wrap: anywhere;
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
</style>
