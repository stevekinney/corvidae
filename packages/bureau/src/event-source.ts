/**
 * Which plugin an event came from (COR-1876). The source is an envelope field, not part of any
 * payload: a Bureau event from core code carries none, and an event a plugin caused through its own
 * host API (COR-1879: a schedule it creates, every event of a goal it creates) carries
 * `source: '<plugin>'`.
 *
 * The source is attached where the event is emitted for the plugin, by {@link markEventSource}, and read by the
 * event feed when it publishes. It is never read off a property of the event, because event
 * classes have fields of their own and one of them could be named `source`.
 *
 * @module event-source
 */

import { isPluginName } from '@lostgradient/interborough-plugin';

const eventSources = new WeakMap<object, string>();

/**
 * Marks `event` as emitted by the plugin `plugin` and returns it. Call it where an event is emitted
 * for the plugin, before it is dispatched; an event of Bureau's own is never marked. Throws a `TypeError` when
 * `plugin` is not a well-formed plugin name or the event already names another plugin.
 */
export function markEventSource<TEvent extends object>(event: TEvent, plugin: string): TEvent {
  if (!isPluginName(plugin)) {
    throw new TypeError(
      `"${String(plugin)}" is not a plugin name, so it cannot be an event source`,
    );
  }
  const existing = eventSources.get(event);
  if (existing !== undefined && existing !== plugin) {
    throw new TypeError(`This event is already from plugin "${existing}", not "${plugin}"`);
  }
  eventSources.set(event, plugin);
  return event;
}

/** The plugin `event` was marked as emitted by, or `undefined` for an event from Bureau core. */
export function eventSourceOf(event: unknown): string | undefined {
  return typeof event === 'object' && event !== null ? eventSources.get(event) : undefined;
}
