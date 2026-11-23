/**
 * Where a hook stands (COR-2181, rows R10-02, R10-03, R10-07 and R10-23): the one status word a list
 * row and a hook's header both show, and the sentence that follows it in the header. The first state
 * that applies wins, in this order:
 *
 * - Off: the hook does not fire. A default hook the owner turned off says so; one its plugin
 *   withdrew says nothing here, because the page's note says it once.
 * - Unavailable: the hook runs a plugin's action that is not offered now, because the plugin is
 *   disabled or no longer offers the action.
 * - Needs attention: the Bureau lists a `configuration-invalid` problem, so the action's schema now
 *   refuses the configuration the hook stored (COR-2182); shown as Unavailable is, from the
 *   Bureau's own say-so.
 * - Needs setup: the action is offered but its plugin needs a secret.
 * - Otherwise the latest delivery's word, or `undefined` for "Nothing sent".
 *
 * The plugin and the action are named by their titles (the plugin's title, else its name in words,
 * and an action's name in words), never by an identifier. A fact the page has not read yet (the
 * plugins, the contributions) is not a state: nothing is guessed from what is not known.
 */
import type { StatusDotWord } from '@lostgradient/cinder';

import type { HookDeclaredBy, ListedHook } from '../../lib/bureau-hooks.ts';
import type { ContributedHookActionKind } from '../../lib/bureau-plugin-kinds.ts';
import type { PluginsSnapshot } from '../../lib/host-plugins.ts';
import { humanizeName } from '../settings/plugins/plugin-presentation.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import { hookStatusWord } from './hook-presentation.ts';

/** What the page knows of the plugins and what they offer; each is `undefined` until it is read. */
export type StandingContext = {
  /** The plugins the host loaded (`GET /host/plugins`). */
  readonly plugins: PluginsSnapshot['plugins'] | undefined;
  /** The hook action kinds the running plugins offer (`bureau.plugins.contributions`). */
  readonly reactions: readonly ContributedHookActionKind[] | undefined;
};

/** The part of a hook the standing reads. */
export type StandingHook = Pick<ListedHook, 'enabled' | 'action'> & {
  /** The newest delivery, which a list carries; a hook read alone has none here. */
  readonly lastDelivery?: ListedHook['lastDelivery'];
  readonly declaredBy?: HookDeclaredBy | null;
  readonly problems?: ListedHook['problems'];
};

/** What the sentence's action is, when it has one. */
export type StandingAction =
  /** Opens the plugin's Settings page with the plugin selected. */
  | { readonly kind: 'settings'; readonly plugin: string; readonly label: string }
  /** Opens the dialog that saves the one secret the plugin lacks. */
  | {
      readonly kind: 'secret';
      readonly plugin: string;
      readonly key: string;
      readonly label: string;
    };

/** The state that decided the word. */
export type StandingState =
  | 'delivery'
  | 'off'
  | 'withdrawn'
  | 'plugin-disabled'
  | 'not-offered'
  | 'workflow-unavailable'
  | 'configuration-invalid'
  | 'needs-setup';

/** A hook's one status. */
export type HookStanding = {
  readonly state: StandingState;
  /** The status word, or `undefined` for a hook that has sent nothing. */
  readonly word: StatusDotWord | undefined;
  /** The sentence after the word, or `undefined` when the header says nothing more. */
  readonly sentence: string | undefined;
  /** The one action the sentence ends in. */
  readonly action?: StandingAction;
  /** The plugin the state is about, by name. */
  readonly plugin?: string;
};

/** A plugin as a person reads it: its title, else its name in words. */
export function pluginTitleOf(
  name: string,
  plugins: PluginsSnapshot['plugins'] | undefined,
): string {
  const found = plugins?.find((plugin) => plugin.descriptor.name === name);
  return found?.descriptor.title ?? humanizeName(name);
}

/** An action as a person reads it: its name in words. */
export function actionTitleOf(kind: string): string {
  return humanizeName(kind);
}

/** The secrets of a plugin that are not saved. */
function missingSecrets(
  plugin: string,
  plugins: PluginsSnapshot['plugins'] | undefined,
): readonly string[] {
  return (
    plugins
      ?.find((candidate) => candidate.descriptor.name === plugin)
      ?.secrets.filter((secret) => !secret.set)
      .map((secret) => secret.key) ?? []
  );
}

/** Where `hook` stands now, given what the page knows. */
export function hookStanding(hook: StandingHook, context: StandingContext): HookStanding {
  const copy = HOOKS_COPY.standing;
  if (!hook.enabled) {
    if (hook.declaredBy?.withdrawn === true) {
      return { state: 'withdrawn', word: 'Off', sentence: undefined };
    }
    return {
      state: 'off',
      word: 'Off',
      sentence: hook.declaredBy?.ownerDisabled === true ? copy.ownerOff : undefined,
    };
  }
  if (hook.problems?.some((problem) => problem.code === 'workflow-unavailable') === true) {
    return {
      state: 'workflow-unavailable',
      word: "Can't load",
      sentence: undefined,
    };
  }
  if (hook.action.type === 'plugin') {
    const { plugin, kind } = hook.action;
    const title = pluginTitleOf(plugin, context.plugins);
    const standing = context.plugins?.find((candidate) => candidate.descriptor.name === plugin);
    const offered = context.reactions?.find(
      (candidate) => candidate.plugin === plugin && candidate.kind === kind,
    );
    const flagged = hook.problems?.some((problem) => problem.code === 'reaction-unavailable');
    if (standing?.status === 'disabled') {
      return {
        state: 'plugin-disabled',
        word: 'Unavailable',
        sentence: copy.disabled(title),
        action: { kind: 'settings', plugin, label: copy.openPlugin(title) },
        plugin,
      };
    }
    if ((context.reactions !== undefined && offered === undefined) || flagged === true) {
      return {
        state: 'not-offered',
        word: 'Unavailable',
        sentence: copy.notOffered(title, actionTitleOf(kind)),
        plugin,
      };
    }
    if (hook.problems?.some((problem) => problem.code === 'configuration-invalid') === true) {
      return {
        state: 'configuration-invalid',
        word: 'Needs attention',
        sentence: copy.configurationInvalid(
          title,
          actionTitleOf(kind),
          hook.declaredBy === null || hook.declaredBy === undefined,
        ),
        plugin,
      };
    }
    if (offered?.availability === 'needs-setup') {
      const missing = missingSecrets(plugin, context.plugins);
      const [only] = missing;
      return {
        state: 'needs-setup',
        word: 'Needs setup',
        sentence: copy.needsSetup(title),
        action:
          missing.length === 1 && only !== undefined
            ? { kind: 'secret', plugin, key: only, label: copy.addKey }
            : { kind: 'settings', plugin, label: copy.openPlugin(title) },
        plugin,
      };
    }
  }
  return {
    state: 'delivery',
    word: hookStatusWord({ enabled: true, lastDelivery: hook.lastDelivery ?? null }),
    sentence: undefined,
  };
}
