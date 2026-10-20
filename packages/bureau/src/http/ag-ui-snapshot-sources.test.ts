/**
 * COR-1546 — every `MESSAGES_SNAPSHOT` the handler sends goes through `snapshotMessages`, which is
 * where the rows a run's memory recall appended are left out of the thread. A route that built its
 * snapshot another way (as the peer stream, which answers for a run another Bureau holds, could)
 * would show a person the recall envelope. This guards the class: no module but `ag-ui-messages.ts`
 * exports a conversation to AG-UI messages, and a module that sends a snapshot uses it.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = import.meta.dir;
const sources = readdirSync(directory)
  .filter((name) => name.endsWith('.ts') && !/\.test(-support)?\.ts$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }));

describe('the AG-UI messages snapshot', () => {
  it('is exported to AG-UI messages in one module', () => {
    const exporting = sources.filter(({ text }) => text.includes('agUiConversationAdapter'));
    expect(exporting.map(({ name }) => name)).toEqual(['ag-ui-messages.ts']);
  });

  it('is built with snapshotMessages by every module that sends one, the peer stream included', () => {
    const sending = sources.filter(({ text }) => text.includes('EventType.MESSAGES_SNAPSHOT'));
    expect(sending.map(({ name }) => name)).toContain('ag-ui-peer-stream.ts');
    for (const { name, text } of sending) {
      expect([name, text.includes('snapshotMessages(')]).toEqual([name, true]);
    }
  });
});
