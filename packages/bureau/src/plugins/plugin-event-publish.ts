/**
 * COR-2224 — `PluginHost.publish`: a plugin publishes one of the events it declared.
 *
 * The call checks, in order, that the plugin declared the name (a `TypeError` naming it), that
 * every secret the plugin declared is set (the secret gate's refusal, as for any contribution), and
 * that the payload satisfies the declared schema (a `TypeError`). Only then does it dispatch a
 * {@link PluginPublishedEvent} of kind `<plugin>:<name>`, marked with the plugin as its source, so
 * the event feed records it. A rejected call dispatches nothing.
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
}

/** The `publish` of one plugin's host API. */
export function createPluginEventPublisher(
  options: PluginEventPublisherOptions,
): (name: string, payload: unknown) => Promise<void> {
  const { plugin, declarations, gate, dispatch } = options;
  return async (name, payload) => {
    const declaration = declarations.find((candidate) => candidate.name === name);
    if (declaration === undefined) {
      throw new TypeError(
        `Plugin "${plugin}" declared no event named "${String(name)}", so it cannot publish one.`,
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
