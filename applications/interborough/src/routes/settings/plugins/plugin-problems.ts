/**
 * The words for a problem a plugin or a folder has: the status it shows, a title, a body with the
 * values the host reported filled in, and the one action that goes to what to fix, when there is
 * somewhere to go. The host reports a problem by `code` plus the fields that code carries
 * (`PluginProblem` in `lib/host-plugins.ts` keeps them loose), so a code this client has no words
 * for still lists, with the code, instead of vanishing. Nothing here touches the page: an action is
 * described, and `plugin-problem-card.svelte` carries it out.
 */
import type { StatusDotStatus } from '@lostgradient/cinder';

import { nameList, PLUGINS_COPY } from '../../../app/copy.ts';
import { agentEditPath } from '../../../lib/agent-paths.ts';
import type { PluginProblem, PluginStanding } from '../../../lib/host-plugins.ts';
import { fieldWords } from './plugin-configuration.ts';
import { identifierOf } from './plugin-presentation.ts';

/** What a problem's button does. */
export type ProblemAction =
  /** Opens the dialog that saves the secret `key`, which needs no restart. */
  | { readonly kind: 'secret'; readonly label: string; readonly key: string }
  /** Moves to the plugin's configuration. */
  | { readonly kind: 'setting'; readonly label: string }
  /** Goes to another page. */
  | { readonly kind: 'link'; readonly label: string; readonly href: string }
  /** Opens the other plugin that holds the name, beside this one. */
  | { readonly kind: 'both'; readonly label: string }
  /** Puts `text` on the clipboard, because the browser cannot do what the label says. */
  | { readonly kind: 'copy'; readonly label: string; readonly text: string };

/** What a problem says, and the action beside it. */
export type ProblemView = {
  /** Where the plugin stands because of it, as a word and the dot that goes with it. */
  readonly status: { readonly label: string; readonly dot: StatusDotStatus };
  readonly title: string;
  readonly body: string;
  readonly action?: ProblemAction;
};

const WARNING = 'warning';
/** A plugin that needs a secret is not failing, so its word is neutral: amber is for what waits on the person. */
const NEUTRAL = 'neutral';
const NOT_LOADED = 'danger';

function text(problem: PluginProblem, field: string): string {
  const value: unknown = Reflect.get(problem, field);
  return typeof value === 'string' ? value : '';
}

function whole(problem: PluginProblem, field: string): number {
  const value: unknown = Reflect.get(problem, field);
  return typeof value === 'number' ? value : 0;
}

function list(problem: PluginProblem, field: string): string[] {
  const value: unknown = Reflect.get(problem, field);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * What waits for a missing secret, as a person reads it. Given the plugin the problem belongs to,
 * a model provider reads `Gemini models`, an embedder `embeddings` and a contribution its own
 * title; without it, or for one the plugin does not list, the identifier the host reported stands.
 * `plural` is whether the phrase reads as more than one thing.
 */
function waitingOnSecret(
  problem: PluginProblem,
  plugin: PluginStanding | undefined,
): { readonly what: string; readonly plural: boolean } {
  const ids = list(problem, 'contributions');
  if (plugin === undefined) return { what: ids.join(', '), plural: ids.length > 1 };
  const phrases: string[] = [];
  let plural = false;
  for (const id of ids) {
    const entry = plugin.contributions.find(
      (candidate) => candidate.id === id || identifierOf(candidate.id) === identifierOf(id),
    );
    const phrase =
      entry === undefined
        ? id
        : entry.kind === 'provider'
          ? `${plugin.descriptor.title} models`
          : entry.kind === 'embedder'
            ? 'embeddings'
            : (entry.title ?? id);
    if (entry?.kind === 'provider' || entry?.kind === 'embedder') plural = true;
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  return { what: nameList(phrases), plural: plural || phrases.length > 1 };
}

/**
 * One side of a name clash, as the sentence names it: the package, the folder, or the built-in
 * plugin. The first word is capitalized when the side opens a sentence.
 */
function partyWords(
  problem: PluginProblem,
  field: string,
  name: string,
  startsSentence: boolean,
): string {
  const value: unknown = Reflect.get(problem, field);
  const source: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'source') : '';
  const location: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'location') : '';
  const where = typeof location === 'string' ? location : '';
  const words =
    source === 'package'
      ? `the package ${where}`
      : source === 'folder'
        ? `the folder ${where}`
        : `the built-in ${name} plugin`;
  return startsSentence ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : words;
}

/** Whether a `configuration-invalid` problem is a provider plugin's model list, at `models` or `models[<index>]`. */
function isAllowlistField(field: string): boolean {
  return /^models(\[\d+\])?$/.test(field);
}

/**
 * A configuration problem's sentence, which names the field the way the form does ("Grounding
 * threshold"), never by its key. A message that already opens with the field's name is left as the
 * plugin wrote it; any other gets the name put in front, so the person can tell which field it is.
 * A key is a path (`models[2]`, `search.address`), so the name is its last segment's.
 */
export function configurationBody(field: string, message: string): string {
  const last =
    field
      .replaceAll(/\[\d+\]/g, '')
      .split('.')
      .pop() ?? '';
  const label = last === '' ? '' : fieldWords(last);
  const named = label !== '' && message.toLowerCase().startsWith(label.toLowerCase());
  return PLUGINS_COPY.problems.configurationInvalid.body(named ? '' : label, message);
}

function configurationView(problem: PluginProblem): ProblemView {
  const words = PLUGINS_COPY.problems;
  const field = text(problem, 'field');
  const allowlist = isAllowlistField(field);
  const set = allowlist ? words.allowlistInvalid : words.configurationInvalid;
  return {
    status: { label: set.status, dot: NOT_LOADED },
    title: set.title,
    body: configurationBody(field, text(problem, 'message')),
    action: { kind: 'setting', label: set.action },
  };
}

function nameClashView(problem: PluginProblem): ProblemView {
  const words = PLUGINS_COPY.problems.nameClash;
  const name = text(problem, 'name');
  const first = partyWords(problem, 'first', name, true);
  const second = partyWords(problem, 'second', name, false);
  return {
    status: { label: words.status, dot: NOT_LOADED },
    title: words.title,
    body: words.body(first, second, name, first),
    action: { kind: 'both', label: words.action },
  };
}

/**
 * The words for one problem. `plugin` is the plugin it belongs to, which lets a body name what the
 * plugin adds as a person reads it instead of by identifier.
 */
export function problemView(problem: PluginProblem, plugin?: PluginStanding): ProblemView {
  const words = PLUGINS_COPY.problems;
  switch (problem.code) {
    case 'secret-missing': {
      const key = text(problem, 'key');
      const { what, plural } = waitingOnSecret(problem, plugin);
      return {
        status: { label: words.secretMissing.status, dot: NEUTRAL },
        title: words.secretMissing.title,
        body:
          what === ''
            ? words.secretMissing.bodyWithoutContributions(key)
            : words.secretMissing.body(key, what, plural),
        ...(key === ''
          ? {}
          : { action: { kind: 'secret', label: words.secretMissing.action, key } }),
      };
    }
    case 'configuration-invalid':
      return configurationView(problem);
    case 'reference-unresolved': {
      const file = text(problem, 'file');
      return {
        status: { label: words.referenceUnresolved.status, dot: WARNING },
        title: words.referenceUnresolved.title,
        body: words.referenceUnresolved.body(file, text(problem, 'id')),
        ...(file === ''
          ? {}
          : {
              action: {
                kind: 'link',
                label: words.referenceUnresolved.action,
                href: agentEditPath(file),
              },
            }),
      };
    }
    case 'name-clash':
      return nameClashView(problem);
    case 'pinned-version-unavailable':
      return {
        status: { label: words.pinnedVersionUnavailable.status, dot: WARNING },
        title: words.pinnedVersionUnavailable.title,
        body: words.pinnedVersionUnavailable.body(
          text(problem, 'id'),
          text(problem, 'version'),
          whole(problem, 'waitingRuns'),
        ),
        action: { kind: 'link', label: words.pinnedVersionUnavailable.action, href: '/runs' },
      };
    case 'development-source': {
      const path = text(problem, 'path');
      return {
        status: { label: words.developmentSource.status, dot: 'accent' },
        title: words.developmentSource.title,
        body: words.developmentSource.body(path),
        ...(path === ''
          ? {}
          : { action: { kind: 'copy', label: words.developmentSource.action, text: path } }),
      };
    }
    case 'secret-refused':
      return {
        status: { label: words.secretRefused.status, dot: NOT_LOADED },
        title: words.secretRefused.title,
        body: words.secretRefused.body(text(problem, 'key'), text(problem, 'message')),
      };
    case 'load-failed':
      return {
        status: { label: words.loadFailed.status, dot: NOT_LOADED },
        title: words.loadFailed.title,
        body: words.loadFailed.body(text(problem, 'message')),
      };
    case 'setup-failed':
      return {
        status: { label: words.setupFailed.status, dot: NOT_LOADED },
        title: words.setupFailed.title,
        body: words.setupFailed.body(text(problem, 'message')),
      };
    case 'after-start-failed':
      return {
        status: { label: words.afterStartFailed.status, dot: WARNING },
        title: words.afterStartFailed.title,
        body: words.afterStartFailed.body(text(problem, 'message')),
      };
    case 'panel-failed':
      return {
        status: { label: words.panelFailed.status, dot: WARNING },
        title: words.panelFailed.title,
        body: words.panelFailed.body(text(problem, 'app'), text(problem, 'message')),
      };
    default:
      return {
        status: { label: words.unknownStatus, dot: 'neutral' },
        title: words.title,
        body: words.unknown(problem.code),
      };
  }
}
