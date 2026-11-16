/**
 * COR-2224 — `PluginHost.publish`: a plugin publishes one of the events it declared.
 *
 * The call checks, in order, that the Bureau is not disposed (a {@link PluginHostDisposedError}:
 * a disposed Bureau records and delivers nothing, so a resolved call would have lost the event),
 * that the plugin declared the name (a `TypeError` naming the kind `<plugin>:<name>`), that every
 * secret the plugin declared is set (the secret gate's refusal, as for any contribution), and that
 * the payload satisfies the declared schema (a `TypeError`). Only then does it dispatch a
 * {@link PluginPublishedEvent} of kind `<plugin>:<name>`, marked with the plugin as its source, so
 * the event feed records it. The checks and the dispatch run in one synchronous stretch, so a
 * dispose cannot fall between them. A rejected call dispatches nothing.
 *
 * @module plugin-event-publish
 */

import type { PluginEventDeclaration } from '@lostgradient/interborough-plugin';

import { markEventSource } from '../event-source';
import { PluginPublishedEvent } from '../plugin-published-event';
import type { PluginSecretGate } from './plugin-secret-gate';

/** What the publisher of one plugin reads. */
export interface PluginEventPublisherOptions {
  /** The plugin's name. */
  readonly plugin: string;
  /** The events the plugin declared. */
  readonly declarations: readonly PluginEventDeclaration[];
  /** The gate over the secrets the plugin declared, when it declares any. */
  readonly gate: PluginSecretGate | undefined;
  /** Dispatches the event on the Bureau emitter. */
  readonly dispatch: (event: Event) => void;
  /** Whether the Bureau no longer records or delivers events. */
  readonly isDisposed: () => boolean;
}

/** A plugin published after the Bureau was disposed, which no longer records or delivers events. */
export class PluginHostDisposedError extends Error {
  /** The plugin that published. */
  readonly plugin: string;

  /** The error for `plugin`'s publish after dispose. */
  constructor(plugin: string) {
    super(`Plugin "${plugin}" cannot publish: the Bureau is disposed.`);
    this.name = 'PluginHostDisposedError';
    this.plugin = plugin;
  }
}

/** The `publish` of one plugin's host API. */
export function createPluginEventPublisher(
  options: PluginEventPublisherOptions,
): (name: string, payload: unknown) => Promise<void> {
  const { plugin, declarations, gate, dispatch, isDisposed } = options;
  return async (name, payload) => {
    if (isDisposed()) throw new PluginHostDisposedError(plugin);
    const declaration = declarations.find((candidate) => candidate.name === name);
    if (declaration === undefined) {
      throw new TypeError(
        `Plugin "${plugin}" declared no event "${plugin}:${name}", so it cannot publish one.`,
      );
    }
    const kind = `${plugin}:${declaration.name}`;
    gate?.assertAvailable(kind);
    const parsed = declaration.payload.safeParse(payload);
    if (!parsed.success) {
      throw new TypeError(
        `The payload of "${kind}" does not match its declared schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(payload)'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    dispatch(markEventSource(new PluginPublishedEvent(kind, parsed.data), plugin));
  };
}
