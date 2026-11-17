/**
 * What the Embedder row of Settings › General says, derived from the embedding status
 * (`bureau.memory.embedding`) and the host's plugins (`GET /host/plugins`): each embedder in words,
 * the cause of a problem with the embedder in use, the line a switch reports, and which embedder a
 * provider's key serves.
 *
 * The status gives identifiers and codes only: an embedder is `hashing` or `<plugin>:<name>`
 * (the registry's own rule, which a plugin's contribution id follows), a problem is the one code
 * `embedder-unavailable`, and a failure is a code. This module is the one place they become words,
 * so no page shows an identifier. A plugin the host does not list is worded from its identifier
 * (`ollama` reads "Ollama"), never shown as it is written.
 */
import type { SelectOption } from '@lostgradient/cinder';

import { EMBEDDER_COPY } from '../../app/copy/embedder.ts';
import type { EmbeddingStatus } from '../../lib/bureau-embedding.ts';
import type { PluginStanding } from '../../lib/host-plugins.ts';

/** The registry id of the built-in embedder, which needs no plugin. */
export const BUILT_IN_EMBEDDER = 'hashing';

/** `text` with its first letter capitalized and the rest left as written. */
function sentenceCase(text: string): string {
  return text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A name written as an identifier (`large-vectors`) as words ("Large vectors"). */
function wordsOf(identifier: string): string {
  return sentenceCase(identifier.replaceAll(/[-_]+/gu, ' ').trim());
}

/** The plugin part of an embedder's id (`gemini` of `gemini:embedder`), or `undefined` for one with no plugin. */
function pluginPart(id: string): string | undefined {
  const colon = id.indexOf(':');
  return colon > 0 ? id.slice(0, colon) : undefined;
}

/** The plugin that adds the embedder `id`, or `undefined` for the built-in one or one no listed plugin owns. */
export function embedderOwner(
  id: string,
  plugins: readonly PluginStanding[],
): PluginStanding | undefined {
  const name = pluginPart(id);
  return name === undefined
    ? undefined
    : plugins.find((candidate) => candidate.descriptor.name === name);
}

/**
 * The embedder `id` as a person says it: "Text hashing" for the built-in one, else its plugin's
 * title, followed after a comma by the embedder's own name in words when the plugin adds more than
 * one ("Multi, Small model").
 */
export function embedderName(id: string, plugins: readonly PluginStanding[]): string {
  if (id === BUILT_IN_EMBEDDER) return EMBEDDER_COPY.builtIn.name;
  const owner = embedderOwner(id, plugins);
  const part = pluginPart(id);
  const title = owner?.descriptor.title ?? wordsOf(part ?? id);
  const own = owner?.contributions.filter((contribution) => contribution.kind === 'embedder') ?? [];
  if (own.length < 2) return title;
  const contribution = own.find((candidate) => candidate.id === id);
  const name = contribution?.title ?? wordsOf(id.slice(id.indexOf(':') + 1));
  return `${title}, ${name}`;
}

/**
 * The options of the picker: every registered embedder once, in registry order; one that needs
 * setup is listed and cannot be chosen; the embedder in use, when no plugin has loaded it, is
 * added as the current value with the note "Not loaded".
 */
export function embedderOptions(
  status: EmbeddingStatus,
  plugins: readonly PluginStanding[],
): SelectOption[] {
  const options = status.embedders.map((embedder): SelectOption => {
    const label = embedderName(embedder.id, plugins);
    return {
      value: embedder.id,
      label,
      ...(embedder.id === BUILT_IN_EMBEDDER ? { suffix: EMBEDDER_COPY.builtIn.suffix } : {}),
      ...(embedder.availability === 'needs-setup'
        ? {
            disabled: true,
            note: EMBEDDER_COPY.needsSetup.note,
            description: EMBEDDER_COPY.needsSetup.description,
          }
        : {}),
    };
  });
  const inUse = status.active.embedder;
  if (!status.embedders.some((embedder) => embedder.id === inUse)) {
    options.push({
      value: inUse,
      label: embedderName(inUse, plugins),
      note: EMBEDDER_COPY.notLoadedNote,
    });
  }
  return options;
}

/** Why the embedder in use cannot serve the memories it made vectors for. */
export type ProblemCause = 'not-loaded' | 'needs-setup' | 'dimension-changed' | 'model-changed';

/**
 * The cause of the status's problem, read from the embedder in use: absent from the registry is
 * not loaded; registered as needing setup is needs setup; available with another dimension than
 * the memories were made with is a changed dimension; and available at the same size is a changed
 * model. `undefined` while the status reports no problem.
 */
export function problemCause(status: EmbeddingStatus): ProblemCause | undefined {
  if (status.problem === null) return undefined;
  const entry = status.embedders.find((embedder) => embedder.id === status.active.embedder);
  if (entry === undefined) return 'not-loaded';
  if (entry.availability === 'needs-setup') return 'needs-setup';
  return entry.dimension === status.active.dimension ? 'model-changed' : 'dimension-changed';
}

/** The cause of a failed switch in words, and the code to show in monospace when the page has no words for it. */
export function failureCause(
  code: string | null,
  target: string,
): { readonly words: string; readonly code?: string } {
  const words = EMBEDDER_COPY.failed.cause(code, target);
  if (words !== undefined) return { words };
  return code === null
    ? { words: EMBEDDER_COPY.failed.unknownCause(target) }
    : { words: EMBEDDER_COPY.failed.unknownCause(target), code };
}

/** The switch a status reports, in the page's words. */
export type SwitchLine =
  | {
      readonly state: 'running';
      readonly target: string;
      readonly current: string;
      readonly done: number;
      readonly total: number;
    }
  | { readonly state: 'canceled'; readonly target: string; readonly current: string }
  | {
      readonly state: 'failed';
      readonly target: string;
      readonly current: string;
      readonly cause: string;
      readonly code: string | undefined;
    };

/**
 * The line the row shows for the status's switch: running with its count, canceled, or failed with
 * its cause. `undefined` while there is none. The wire's `cancelled` is the word "Canceled".
 */
export function switchLine(
  status: EmbeddingStatus,
  plugins: readonly PluginStanding[],
): SwitchLine | undefined {
  const { job } = status;
  if (job === null) return undefined;
  const target = embedderName(job.target, plugins);
  const current = embedderName(status.active.embedder, plugins);
  if (job.state === 'running') {
    return { state: 'running', target, current, done: job.done, total: job.total };
  }
  if (job.state === 'cancelled') return { state: 'canceled', target, current };
  const cause = failureCause(job.error, target);
  return { state: 'failed', target, current, cause: cause.words, code: cause.code };
}

/**
 * The embedder of a provider's plugin that memory uses now or is switching to, for the sentence of
 * the remove-key dialog: the embedder in use when the plugin adds it, else the target of a running
 * switch. A switch that failed or was canceled moves nowhere, so it names nothing.
 */
export function providerEmbedder(
  plugin: PluginStanding | undefined,
  status: EmbeddingStatus,
): string | undefined {
  if (plugin === undefined) return undefined;
  const offered = new Set(
    plugin.contributions
      .filter((contribution) => contribution.kind === 'embedder')
      .map((contribution) => contribution.id),
  );
  if (offered.has(status.active.embedder)) return status.active.embedder;
  const { job } = status;
  return job !== null && job.state === 'running' && offered.has(job.target)
    ? job.target
    : undefined;
}
