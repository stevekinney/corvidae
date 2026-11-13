import type { EngineInterface, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';

import type { CompanionHost, Poller } from './connection';
import { createPoller } from './connection';
import { describeConnection, labelOf, summaryOf, waitingOf } from './view';

const PANE = 'attention-queue';
const DEFAULT_RUNTIME_FILE = '.attention-queue/runtime.json';

// The mod's reactive view of the service's records. The service stays the
// authority; these values are a cache the drawings read.
const items = atom({ plugin: 'attention-queue', key: 'items' } as const, [], { shape: 'items-1' });
const connection = atom({ plugin: 'attention-queue', key: 'connection' } as const, {
  kind: 'connecting',
});

// One id per loaded copy of this module: to the service, a reload is a new instance.
const instanceId = crypto.randomUUID();

let poller: Poller | undefined;

/** Acknowledging is a deliberate action, so it only ever runs from the person's press. */
async function acknowledge($: EngineInterface, id: string): Promise<void> {
  const isAcknowledged = await (poller?.acknowledge(id) ?? Promise.resolve(false)).catch(
    () => false,
  );
  if (!isAcknowledged)
    $.ui.toast('The service did not acknowledge that item; it is still in the queue.');
}

export const register: Register = (on, options) => {
  const configuredRuntimeFile =
    typeof options.runtimeFile === 'string' ? options.runtimeFile.trim() : '';

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'attention',
        description:
          'Open the attention queue: approvals, failed checks, expired claims, and handoffs',
        immediate: true,
      });
    } catch (error) {
      $.ui.log(`/attention was not registered: ${String(error)}`, { to: 'debug' });
    }

    const home = (await $.env.get('HOME')) ?? '';
    const runtimeFile =
      configuredRuntimeFile === '' ? `${home}/${DEFAULT_RUNTIME_FILE}` : configuredRuntimeFile;

    // The capability adapter: each member spells its `$` call here, in the
    // hook, and the poller module receives nothing broader than this object.
    const host: CompanionHost = {
      readRuntimeFile: () => $.fs.read(runtimeFile),
      fetch: (url, init) => $.http.fetch(url, init),
      now: () => $.clock.now(),
      after: (milliseconds, callback) => $.clock.after(milliseconds, callback),
      sessionId: () => $.session.id(),
      random: () => Math.random(),
    };

    poller?.stop();
    poller = createPoller({
      host,
      instanceId,
      onItems: (latest) => update($, items, () => latest),
      onConnection: async (latest) => {
        $.ui.status(describeConnection(latest));
        await update($, connection, () => latest);
      },
    });
    poller.start();
    return next(e);
  });

  on('command.run', { command: 'attention' }, async ($) => {
    const opened = await $.ui.open({
      id: PANE,
      title: 'Attention',
      focus: true,
      closeOnEscape: true,
    });
    if (opened.isPlaced) return {};
    const problem = describeConnection(await read($, connection));
    return { text: problem ?? summaryOf(waitingOf(await read($, items))) };
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const problem = describeConnection(await read($, connection));
    const waiting = waitingOf(await read($, items));
    const shown = waiting.slice(0, Math.max(1, e.props.scroll.bodyRows - 1));

    return (
      <Box flexDirection="column">
        {problem !== undefined && <Text color="warning">{problem}</Text>}
        {problem === undefined && waiting.length === 0 && (
          <Text dimColor>Nothing needs you right now.</Text>
        )}
        {shown.map((item) => (
          <Box key={`item-${item.id}`} flexDirection="row" columnGap={1}>
            <Button
              key={`acknowledge-${item.id}`}
              label="Acknowledge"
              plain
              onPress={() => acknowledge($, item.id)}
            />
            <Text wrap="truncate-end">{`${labelOf(item.kind)}: ${item.title}`}</Text>
          </Box>
        ))}
      </Box>
    );
  });

  // The band shows only while connected with something waiting, and keeps the
  // bands of the mods after this one; problems go to the status line instead.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, connection);
    const waiting = waitingOf(await read($, items));
    if (e.props.hasSurvey || current.kind !== 'connected' || waiting.length === 0) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    const theirs = await next(e);

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text>{summaryOf(waiting)}</Text>
          <Button
            key="open-attention"
            label="Open"
            plain
            onPress={() =>
              $.ui.open({ id: PANE, title: 'Attention', focus: true, closeOnEscape: true })
            }
          />
        </Box>
        {theirs}
      </Box>
    );
  });
};
