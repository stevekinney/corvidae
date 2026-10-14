import type { Component } from 'svelte';

/**
 * Lazy loaders for the trusted Cinder examples the preview scenes compose, keyed by
 * `<component>/<scenario>`. They are listed explicitly, not built from a glob or from
 * scene data, so the preview bundle imports exactly these fourteen files and nothing a
 * theme (or an import) could name. `theme-preview-scenes.test.ts` keeps the keys equal to
 * the example ids the manifest references.
 */
type ExampleModule = { default: unknown };

/** Some examples declare `mountIdPrefix` and the rest ignore it, so every one can be handed it. */
export function exampleComponent(module: ExampleModule): Component<{ mountIdPrefix?: string }> {
  return module.default as Component<{ mountIdPrefix?: string }>;
}

export const THEME_PREVIEW_EXAMPLE_LOADERS: Readonly<Record<string, () => Promise<ExampleModule>>> =
  {
    'button/variants': () => import('../examples/button/variants.example.svelte'),
    'link/basic': () => import('../examples/link/basic.example.svelte'),
    'input/basic': () => import('../examples/input/basic.example.svelte'),
    'input/with-error': () => import('../examples/input/with-error.example.svelte'),
    'select/basic': () => import('../examples/select/basic.example.svelte'),
    'select/with-error': () => import('../examples/select/with-error.example.svelte'),
    'checkbox/basic': () => import('../examples/checkbox/basic.example.svelte'),
    'checkbox/with-error': () => import('../examples/checkbox/with-error.example.svelte'),
    'tabs/basic': () => import('../examples/tabs/basic.example.svelte'),
    'callout/variants': () => import('../examples/callout/variants.example.svelte'),
    'table/basic': () => import('../examples/table/basic.example.svelte'),
    'line-chart/multi-series': () => import('../examples/line-chart/multi-series.example.svelte'),
    'modal/with-form': () => import('../examples/modal/with-form.example.svelte'),
    'popover/basic': () => import('../examples/popover/basic.example.svelte'),
  };
