import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { settingsSchema } from './settings-schema.ts';

type Node = {
  properties?: Record<string, Node>;
  anyOf?: Node[];
  unit?: string;
  description?: string;
};

const published = z.toJSONSchema(settingsSchema, { io: 'input' }) as {
  properties: Record<string, Node>;
};

/** The `olderThan` field of a retention setting, whether the setting is a window or a choice of one. */
function olderThanOf(key: string): Node | undefined {
  const node = published.properties[key];
  const objects = node?.anyOf === undefined ? [node] : node.anyOf;
  return objects.find((candidate) => candidate?.properties?.['olderThan'] !== undefined)
    ?.properties?.['olderThan'];
}

describe('the published settings schema', () => {
  test('says on each olderThan field that it is a number of milliseconds', () => {
    const retention = Object.keys(published.properties).filter((key) =>
      key.startsWith('retention.'),
    );
    const windows = retention.filter((key) => olderThanOf(key) !== undefined);
    expect(windows.length).toBeGreaterThan(5);
    for (const key of windows) expect(olderThanOf(key)?.unit, key).toBe('milliseconds');
  });

  test('says in its description that the payload size is a number of bytes, since its field name is the only other word for it', () => {
    expect(published.properties['engine.payloadSize']?.description).toContain('in bytes');
  });

  test('puts no unit on a count, so a form does not read it as a duration', () => {
    const history = published.properties['engine.history']?.properties?.['maxEvents'];
    expect(history).toBeDefined();
    expect(history?.unit).toBeUndefined();
  });
});
