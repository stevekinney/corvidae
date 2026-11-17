/**
 * COR-2180 — what the Bureau does with the hooks its plugins declare, once its hooks exist: it
 * reconciles each running plugin's accepted declarations (`BureauHooks.reconcileDeclared`, COR-2179),
 * and withdraws the default hooks of a plugin the host no longer gives it. A plugin that is disabled,
 * or whose setup failed, is left alone: its hooks stay as they are and run nothing, because their
 * reaction is not registered, and only an empty list would withdraw them.
 *
 * A refusal never fails the Bureau. A hook that `reconcileDeclared` refuses (it names a bad
 * configuration or scope, or an event kind this release does not accept) is left out, the others are
 * reconciled again, and the plugin lists a `hook-invalid` problem that names it and the field.
 *
 * @module reconcile-plugin-hooks
 */

import type { PluginHook } from '@lostgradient/interborough-plugin';

import type { DiagnosticSink } from '../bureau-types/options';
import type { HookInvalidPath } from '../plugins/plugin-types';
import type { PluginRegistry } from '../plugins/plugin-registry';
import type { BureauHooks, HookDeclaration } from './create-hooks';
import { HookError } from './hook-types';

/** The longest a hook's name is when a problem names it. */
const NAME_LIMIT = 100;

const PATHS: ReadonlySet<string> = new Set<HookInvalidPath>([
  'name',
  'reaction',
  'events',
  'configuration',
  'scope',
]);

/** What {@link reconcilePluginHooks} reads from the plugin registry. */
export type HookPluginSource = Pick<
  PluginRegistry,
  'declaredHooks' | 'knownPlugins' | 'reportHookProblems'
>;

/** The field a refusal names, as a problem's `path`. */
function pathOf(field: unknown): HookInvalidPath {
  return typeof field === 'string' && PATHS.has(field) ? (field as HookInvalidPath) : 'declaration';
}

/**
 * Reconciles `declared` for `plugin`, leaving out each declaration `reconcileDeclared` refuses, and
 * resolves with the refusals. A failure that names no declaration is reported and ends the attempt.
 */
async function reconcileOne(
  hooks: BureauHooks,
  plugin: string,
  declared: readonly PluginHook[],
  diagnose: DiagnosticSink,
): Promise<{ readonly hook: string; readonly path: HookInvalidPath }[]> {
  const refused: { hook: string; path: HookInvalidPath }[] = [];
  let remaining = [...declared];
  for (;;) {
    try {
      await hooks.reconcileDeclared(plugin, remaining as readonly HookDeclaration[]);
      return refused;
    } catch (error) {
      const issue =
        error instanceof HookError && error.code === 'invalid' ? error.issues[0] : undefined;
      const index = Number(issue?.path[0]);
      const at = remaining[index];
      if (issue === undefined || at === undefined || !Number.isInteger(index)) {
        diagnose({
          level: 'error',
          scope: 'hooks',
          message: `[bureau] Could not reconcile the default hooks of plugin ${plugin}`,
          cause: error,
        });
        return refused;
      }
      refused.push({ hook: at.name.slice(0, NAME_LIMIT), path: pathOf(issue.path[1]) });
      remaining = remaining.filter((_, position) => position !== index);
    }
  }
}

/**
 * Reconciles the default hooks of every running plugin, and withdraws those of a plugin that is not
 * known at all. Nothing here throws: the Bureau starts whatever a hook, a plugin or the store does.
 */
export async function reconcilePluginHooks(input: {
  readonly hooks: BureauHooks | undefined;
  readonly plugins: HookPluginSource;
  readonly diagnose: DiagnosticSink;
}): Promise<void> {
  const { hooks, plugins, diagnose } = input;
  if (hooks === undefined) return;
  try {
    const known = plugins.knownPlugins();
    // The hook records alone: a start reads no delivery.
    const declaredBy = new Set(await hooks.declaredPlugins());
    for (const { plugin, hooks: declared } of plugins.declaredHooks()) {
      // A plugin that declares none and has none made nothing to withdraw.
      if (declared.length === 0 && !declaredBy.has(plugin)) continue;
      plugins.reportHookProblems(plugin, await reconcileOne(hooks, plugin, declared, diagnose));
    }
    for (const plugin of declaredBy) {
      if (!known.has(plugin)) await reconcileOne(hooks, plugin, [], diagnose);
    }
  } catch (error) {
    diagnose({
      level: 'error',
      scope: 'hooks',
      message: '[bureau] Could not reconcile the default hooks of the plugins',
      cause: error,
    });
  }
}
