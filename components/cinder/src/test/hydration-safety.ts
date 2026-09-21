/**
 * Build-flag hydration-safety test helper.
 *
 * This compares real server renders compiled under the two `esm-env` export
 * condition sets. A `{#if BROWSER}` branch then differs between the server
 * (`BROWSER=false`) and browser (`BROWSER=true`) builds, while a `hydrated`
 * `$effect` gate remains absent from both initial renders.
 *
 * The result is a build-flag invariance check, not a complete hydration proof:
 * it does not validate bindings, actions, event attachment, lifecycle order,
 * or DOM mutation during hydration.
 */
import { renderSvelteOnServer } from '@lostgradient/testing';

/** Result of a build-flag hydration-safety check. */
export type HydrationSafetyResult = {
  /** True when SSR markup is identical under `BROWSER=false` and `BROWSER=true`. */
  buildFlagInvariant: boolean;
  /** SSR markup with the `browser` condition off (`BROWSER=false`). */
  serverHtml: string;
  /** SSR markup with the `browser` condition on (`BROWSER=true`). */
  clientHtml: string;
};

/**
 * Build a small `esm-env` probe under one export-condition set.
 *
 * The discriminator proves that the conditions passed to the shared server
 * renderer still select different `BROWSER` values before any real check runs.
 */
async function buildDiscriminatorProbe(conditions: readonly string[]): Promise<string> {
  const entrypoint = 'hydration-safety-browser-flag-discriminator';
  const namespace = 'hydration-safety-discriminator';
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: 'bun',
    conditions: [...conditions],
    plugins: [
      {
        name: namespace,
        setup(builder) {
          builder.onResolve({ filter: new RegExp(`^${entrypoint}$`) }, () => ({
            path: entrypoint,
            namespace,
          }));
          builder.onLoad({ filter: /.*/, namespace }, () => ({
            contents: "import { BROWSER } from 'esm-env'; export default BROWSER;",
            loader: 'js',
          }));
        },
      },
    ],
  });
  if (!build.success) {
    const logText = build.logs.map((log) => log.message ?? JSON.stringify(log)).join('\n');
    throw new Error(`hydration-safety: build-flag discriminator failed\n${logText}`);
  }
  const artifact = build.outputs[0];
  if (!artifact) throw new Error('hydration-safety: build-flag discriminator emitted no artifact');
  return artifact.text();
}

/** Render a fixture through the shared isolated server renderer. */
function renderWithConditions(
  componentPath: string,
  conditions: readonly string[],
  props: Record<string, unknown>,
): Promise<string> {
  return renderSvelteOnServer(componentPath, props, { conditions });
}

/**
 * Render `componentPath` once with `BROWSER=false` and once with `BROWSER=true`.
 * If the outputs differ, the component's initial markup depends on the
 * `esm-env` build flag and is unsafe for hydration until that branch is gated
 * on post-hydration state.
 */
export async function checkBuildFlagHydrationSafety(
  componentPath: string,
  props: Record<string, unknown> = {},
): Promise<HydrationSafetyResult> {
  await assertDiscriminatorWorks();
  const serverHtml = await renderWithConditions(componentPath, ['svelte'], props);
  const clientHtml = await renderWithConditions(componentPath, ['browser', 'svelte'], props);
  return { buildFlagInvariant: serverHtml === clientHtml, serverHtml, clientHtml };
}

/** Fail closed if the `BROWSER` build-flag split stops working. */
let discriminatorVerified: Promise<void> | null = null;
function assertDiscriminatorWorks(): Promise<void> {
  discriminatorVerified ??= (async () => {
    const off = await buildDiscriminatorProbe(['svelte']);
    const on = await buildDiscriminatorProbe(['browser', 'svelte']);
    if (off === on) {
      throw new Error(
        'hydration-safety: the BROWSER build-flag discriminator is not working — the ' +
          '`esm-env` probe bundled identically under both build conditions. ' +
          'Investigate esm-env resolution / Bun.build conditions before trusting any ' +
          '`buildFlagInvariant` result.',
      );
    }
  })();
  return discriminatorVerified;
}
