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
    'button/variants': () =>
      import('../../../../components/button/src/components/button/examples/variants.example.svelte'),
    'link/basic': () =>
      import('../../../../components/link/src/components/link/examples/basic.example.svelte'),
    'input/basic': () =>
      import('../../../../components/input/src/components/input/examples/basic.example.svelte'),
    'input/with-error': () =>
      import('../../../../components/input/src/components/input/examples/with-error.example.svelte'),
    'select/basic': () =>
      import('../../../../components/select/src/components/select/examples/basic.example.svelte'),
    'select/with-error': () =>
      import('../../../../components/select/src/components/select/examples/with-error.example.svelte'),
    'checkbox/basic': () =>
      import('../../../../components/checkbox/src/components/checkbox/examples/basic.example.svelte'),
    'checkbox/with-error': () =>
      import('../../../../components/core/src/components/checkbox/examples/with-error.example.svelte'),
    'tabs/basic': () =>
      import('../../../../components/core/src/components/tabs/examples/basic.example.svelte'),
    'callout/variants': () =>
      import('../../../../components/callout/src/components/callout/examples/variants.example.svelte'),
    'table/basic': () =>
      import('../../../../components/table/src/components/table/examples/basic.example.svelte'),
    'line-chart/multi-series': () =>
      import('../../../../components/chart/src/components/line-chart/examples/multi-series.example.svelte'),
    'modal/with-form': () =>
      import('../../../../components/core/src/components/modal/examples/with-form.example.svelte'),
    'popover/basic': () =>
      import('../../../../components/core/src/components/popover/examples/basic.example.svelte'),
  };
