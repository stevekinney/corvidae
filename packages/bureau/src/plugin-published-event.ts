/**
 * COR-2224 — an event a plugin publishes through `host.publish`. Its `type` is the plugin's
 * declared kind, `<plugin>:<name>`, and its `payload` is what the declared schema accepted. It is
 * dispatched on the Bureau emitter marked with the plugin as its source, so the event feed records
 * it with the cursors and replay every other event has.
 *
 * @module plugin-published-event
 */

/** An event of a kind a plugin declared, carrying the payload its schema accepted. */
export class PluginPublishedEvent extends Event {
  /** The payload the declared schema accepted. */
  readonly payload: Readonly<Record<string, unknown>>;

  /** The event of `kind` (`<plugin>:<name>`) with `payload`. */
  constructor(kind: string, payload: Readonly<Record<string, unknown>>) {
    super(kind);
    this.payload = payload;
  }
}
