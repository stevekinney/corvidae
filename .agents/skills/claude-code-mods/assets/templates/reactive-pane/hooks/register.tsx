import type { EngineInterface, Register, Timer } from 'claude-code';
import { atom, derive, memberOf, read, update } from 'claude-code';

import { countsOf, fitted, markerOf, rowsOf, summaryOf } from './roster';

const PANE = 'agent-roster';
const BAND_HIDDEN_KEY = 'isBandHidden';
const EMPTY_TEXT = 'No subagents or teammates in this session yet.';

// Atoms describe values the host keeps for the session. Each is a `const`
// with literal `plugin` and `key`, so `claude plugin validate` can list them.
// Change the shape tag whenever AgentRow changes: a value an older build of
// this module stored outlives a reload, and the tag is how new code declines it.
const agents = atom({ plugin: 'agent-roster', key: 'agents' } as const, [], {
  shape: 'agents-1',
});
const isExpanded = atom({ plugin: 'agent-roster', key: 'isExpanded' } as const, false);
const isBandHidden = atom({ plugin: 'agent-roster', key: 'isBandHidden' } as const, false);
const counts = derive([agents], (rows) => countsOf(rows));

// Module state: disposable. A reload drops the pending timer with the module.
let refreshTimer: Timer | undefined;
let isRefreshing = false;
let isRefreshQueued = false;
let isRestoreNeeded = false;

/** Reads the agent list once at a time; a request that arrives meanwhile runs once after. */
async function refreshAgents($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    isRefreshQueued = true;
    return;
  }
  isRefreshing = true;
  try {
    do {
      isRefreshQueued = false;
      const listed = await $.agent.list();
      await update($, agents, () => rowsOf(listed));
    } while (isRefreshQueued);
  } finally {
    isRefreshing = false;
  }
}

/** Coalesces a burst of events into one refresh a quarter second later. */
function scheduleRefresh($: EngineInterface): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = $.clock.after(250, () => {
    refreshTimer = undefined;
    refreshAgents($).catch((error: unknown) => {
      $.ui.log(`refresh failed: ${String(error)}`, { to: 'debug' });
    });
  });
}

/** Copies the person's band preference from `$.store` into `$.state`. */
async function restorePreferences($: EngineInterface): Promise<void> {
  const stored = await $.store.get(BAND_HIDDEN_KEY);
  await update($, isBandHidden, () => stored === true);
}

/** Saves the preference first, then shows it, so a reset never overwrites what was stored. */
async function setBandHidden($: EngineInterface, isHidden: boolean): Promise<void> {
  await $.store.set(BAND_HIDDEN_KEY, isHidden);
  await update($, isBandHidden, () => isHidden);
}

export const register: Register = (on) => {
  // Load and every reload: restore, register (safe to repeat), refresh.
  on('session.start', async ($, e, next) => {
    await restorePreferences($);
    try {
      await $.command.register({
        name: 'agent-roster',
        description: "Open a pane listing this session's subagents and teammates",
        immediate: true,
      });
    } catch (error) {
      $.ui.log(`/agent-roster was not registered: ${String(error)}`, { to: 'debug' });
    }
    scheduleRefresh($);
    return next(e);
  });

  // /clear, /resume and /branch reset $.state and do not raise session.start.
  // The settings-hook bridge re-hydrates at once, but where the built-in guard
  // loads, a user-installed mod's classic.* hooks never run. The pair after it
  // is the fallback that works in both cases: mark the reset, restore on the
  // next main-loop turn.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    isRestoreNeeded = false;
    await restorePreferences($);
    scheduleRefresh($);
    return next(e);
  });

  on('session.end', { reason: ['clear', 'resume'] }, async ($, e, next) => {
    isRestoreNeeded = true;
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    if (isRestoreNeeded && e.agentId === undefined) {
      isRestoreNeeded = false;
      await restorePreferences($);
    }
    scheduleRefresh($);
    return next(e);
  });

  // A subagent's turn ends with agentId set; either way the roster may have changed.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    scheduleRefresh($);
    return result;
  });

  // The person asked, so the pane may open at any terminal width. Where nothing
  // places a pane (claude -p, a narrow unasked open), answer with text instead.
  on('command.run', { command: 'agent-roster' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'Agents', focus: true, closeOnEscape: true });
    if (opened.isPlaced) return {};
    const rows = await read($, agents);
    return { text: rows.length === 0 ? EMPTY_TEXT : `Agents: ${summaryOf(countsOf(rows))}` };
  });

  // Rendering reads state and returns a tree; every write happens in a handler.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const rows = await read($, agents);
    const isHidden = await read($, isBandHidden);
    const width = Math.max(20, e.props.bodyColumns);
    const shown = rows.slice(-Math.max(1, e.props.scroll.bodyRows - 2));
    const expandedFlags = await Promise.all(
      shown.map((row) => read($, memberOf(isExpanded, { requestId: row.id }))),
    );

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>{EMPTY_TEXT}</Text>}
        {shown.map((row, index) => (
          <Box key={`row-${row.id}`} flexDirection="column">
            <Button
              key={`agent-${row.id}`}
              plain
              onPress={() =>
                update($, memberOf(isExpanded, { requestId: row.id }), (value) => !value)
              }
            >
              {markerOf(row.status)} {fitted(row.description || row.type, width - 14)}{' '}
              <Text dimColor>{row.status}</Text>
            </Button>
            {expandedFlags[index] === true && (
              <Text dimColor wrap="truncate-end">
                {`  ${row.type}, id ${row.id}${row.parentId === null ? '' : `, started by ${row.parentId}`}`}
              </Text>
            )}
          </Box>
        ))}
        {isHidden && (
          <Button
            key="show-band"
            label="Show the band above the prompt"
            onPress={() => setBandHidden($, false)}
          />
        )}
      </Box>
    );
  });

  // The band is shared by every mod. Returning next(e) when there is nothing to
  // show, and keeping next(e)'s result inside the tree otherwise, leaves the
  // other mods' bands drawn. The Box around it takes no size or position props.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, agents);
    if (e.props.hasSurvey || rows.length === 0 || (await read($, isBandHidden))) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    const summary = summaryOf(await read($, counts));
    const theirs = await next(e);

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>
            {fitted(`Agents: ${summary}`, Math.max(10, e.props.bodyColumns - 24))}
          </Text>
          <Button
            key="open"
            label="Open"
            plain
            onPress={() =>
              $.ui.open({ id: PANE, title: 'Agents', focus: true, closeOnEscape: true })
            }
          />
          <Button key="hide" label="Hide" plain onPress={() => setBandHidden($, true)} />
        </Box>
        {theirs}
      </Box>
    );
  });
};
