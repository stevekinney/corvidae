/**
 * The words of the Embedder row of Settings › General (`memory.embedder`, design rows EM6-01 to
 * EM6-23): the picker over the embedders memory can use, the switch to another one with its
 * progress, its cancel and its failure, and what the row says while the embedder in use has a
 * problem. An embedder is named by its plugin's title; no identifier and no failure code is a word
 * here, but the one unknown code a failed switch can carry, which the row shows in monospace.
 *
 * The status words (Running, Failed, Canceled) are Cinder's `StatusDot` words and are not repeated
 * here.
 */

/** The cause of a failed switch, in words, for each code the Bureau names. */
const FAILURE_CAUSES: Readonly<Record<string, (embedder: string) => string>> = {
  'target-unavailable': (embedder) => `${embedder} wasn’t loaded after a restart`,
  'target-missing': (embedder) => `${embedder} isn’t installed any more`,
  'embedder-failed': (embedder) => `${embedder} couldn’t embed one of the memories`,
  'embedder-timeout': (embedder) => `${embedder} took too long to answer`,
};

export const EMBEDDER_COPY = {
  /** The one embedder that is built in, which needs no plugin and no key. */
  builtIn: { name: 'Text hashing', suffix: 'built in' },
  /** What the picker marks an embedder with that is listed but cannot be chosen yet. */
  needsSetup: {
    note: 'Needs setup',
    description: 'Save its key in Settings › Plugins first.',
  },
  /** The note of the embedder in use that no plugin has loaded. */
  notLoadedNote: 'Not loaded',
  /** The row's description with one embedder registered, and the link after it. */
  onlyEmbedder: (name: string): string => `${name} is the only embedder. Plugins can add others.`,
  openPlugins: 'Open Plugins',
  /** The row's description on a home that keeps no memory. */
  noMemory: 'This home keeps no memory, so there is nothing to embed.',
  /** The row's own load error, and its quiet retry is the row's own "Try again". */
  loadFailed: 'Couldn’t load the embedders.',
  /** The confirmation before a switch starts. */
  confirmSwitch: {
    title: (next: string): string => `Switch memory search to ${next}?`,
    description: (next: string, current: string): string =>
      `Interborough embeds every stored memory again with ${next}. Search keeps using ${current} until all of them are done, and you can cancel at any point. A paid embedder charges for each memory it embeds.`,
    confirm: 'Switch embedder',
    busy: 'Switching…',
    keep: (current: string): string => `Keep ${current}`,
  },
  /** The confirmation before the embedder in use embeds every memory again ("Embed again"). */
  confirmAgain: {
    title: (current: string): string => `Embed every memory again with ${current}?`,
    description: (current: string): string =>
      `Interborough embeds every stored memory again with ${current}. Search matches words only until all of them are done, and you can cancel at any point. A paid embedder charges for each memory it embeds.`,
    confirm: 'Embed again',
    busy: 'Starting…',
    cancel: 'Not now',
  },
  /** The line under the row while a switch runs. */
  running: {
    sentence: (next: string, done: number, total: number): string =>
      `Switch to ${next}, ${String(done)} of ${String(total)} memories`,
    progressLabel: 'Memories embedded',
    cancel: 'Cancel switch',
  },
  /** The confirmation before a running switch is cancelled. */
  confirmCancel: {
    title: (next: string): string => `Cancel the switch to ${next}?`,
    description: (done: number, current: string): string =>
      `The ${String(done)} memories embedded so far are thrown away. Search keeps using ${current}, and nothing else changes.`,
    confirm: 'Cancel switch',
    busy: 'Canceling…',
    keep: 'Keep switching',
    failedTitle: 'Couldn’t cancel the switch.',
    failed: 'Interborough didn’t answer. The switch is still running.',
  },
  /** The line after a cancel, kept until another switch starts. */
  canceled: (next: string, current: string): string =>
    `You canceled the switch to ${next}. Search still uses ${current}.`,
  /** The line after a failed switch. */
  failed: {
    lead: (next: string, cause: string): string => `The switch to ${next} failed: ${cause}`,
    tail: (current: string): string => `. Search still uses ${current}.`,
    retry: 'Retry switch',
    /** The cause of a failure code this page has no words for; the code follows it in monospace. */
    unknownCause: (next: string): string => `${next} stopped the switch`,
    /** The cause of a failure code the page knows, or `undefined` for a code it does not. */
    cause: (code: string | null, next: string): string | undefined =>
      code !== null && Object.hasOwn(FAILURE_CAUSES, code)
        ? FAILURE_CAUSES[code]?.(next)
        : undefined,
  },
  /** What the row's description says in place of the Bureau's while the embedder in use has a problem. */
  problem: {
    notLoaded: (current: string): string =>
      `${current} isn’t loaded, so memory search matches words only until it’s back or you switch embedders.`,
    needsSetup: (current: string): string =>
      `${current} needs its key, so memory search matches words only until it’s saved.`,
    dimensionChanged: (current: string): string =>
      `${current} now makes vectors of another size than your memories were made with, so search matches words only.`,
    modelChanged: (current: string): string =>
      `${current} now runs another model than your memories were made with, so search matches words only.`,
    addKey: 'Add the key',
    openPlugin: (plugin: string): string => `Open ${plugin} in Settings`,
    embedAgain: 'Embed again',
  },
  /** A switch the server refused, or that never reached it. Nothing changed either way. */
  refused: {
    row: (next: string, reason: string): string =>
      `Couldn’t switch to ${next}: ${reason}. Nothing changed.`,
    reasons: {
      running: 'another switch is already running',
      needsSetup: (next: string): string => `${next} needs its key first`,
      notLoaded: (next: string): string => `${next} isn’t loaded`,
      noMemory: 'this home keeps no memory',
      locked: 'the deployment sets it',
      forbidden: 'you may read the settings but not change them',
      stale: 'the settings changed while you were choosing',
      unanswered: 'Interborough didn’t answer',
      other: 'Interborough didn’t accept it',
    },
  },
  /** The sentence of the remove-key dialog when memory uses an embedder from the provider. */
  removeKey: (embedder: string): string =>
    `Memory search uses ${embedder} from this provider. Removing the key stops it, so search matches words only until you add a key or switch embedders.`,
} as const;
