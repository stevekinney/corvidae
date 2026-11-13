import { describe, expect, mock, test } from 'claude-code/testing';

import { countsOf, fitted, summaryOf } from '../hooks/roster';

const PANE = {
  plugin: 'agent-roster',
  component: 'Pane',
  requestId: 'agent-roster',
  props: {
    title: 'Agents',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

const BAND = {
  plugin: 'agent-roster',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

const LISTED_AGENTS = [
  { id: 'a1', description: 'Survey the test suite', type: 'Explore', status: 'running' },
  { id: 'a2', description: 'Draft the migration', type: 'general-purpose', status: 'completed' },
] as const;

describe('roster', () => {
  test('summarizes agents by group', () => {
    const rows = LISTED_AGENTS.map((agent) => ({ ...agent, parentId: null }));
    expect(summaryOf(countsOf(rows))).toBe('1 working, 1 done');
    expect(summaryOf(countsOf([]))).toBe('none yet');
  });

  test('fits text to a width with an ellipsis', () => {
    expect(fitted('abcdef', 4)).toBe('abc…');
    expect(fitted('abc', 4)).toBe('abc');
  });
});

describe('register', () => {
  test('the pane lists and expands agents on every surface that draws panes', async ($, on) => {
    const clock = mock.clock(on);
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('store.get', () => ({ value: undefined }));
    on('agent.list', () => ({ value: [...LISTED_AGENTS] }));

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    // The refresh is coalesced behind a 250 millisecond timer.
    await clock.advance(250);

    for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface });
      expect(await ui.find({ key: 'agent-a1' })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: 'completed' })).toBeDefined();
      await ui.press({ key: 'agent-a1' });
      expect(await ui.find({ type: 'Text', text: /Explore, id a1/ })).toBeDefined();
      // Collapse again so the next surface starts from the same state.
      await ui.press({ key: 'agent-a1' });
      await ui.unmount();
    }
  });

  test('the band keeps what the mods beneath it draw', async ($, on) => {
    const clock = mock.clock(on);
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('store.get', () => ({ value: undefined }));
    on('agent.list', () => ({ value: [...LISTED_AGENTS] }));
    // Stands for every mod after this one and Claude Code's own drawing.
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e);
      return <Text>another band</Text>;
    });

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await clock.advance(250);

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface });
      expect(await ui.find({ type: 'Text', text: 'Agents: 1 working, 1 done' })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: 'another band' })).toBeDefined();
      await ui.unmount();
    }
  });

  test('hiding the band saves the choice and leaves the band to others', async ($, on) => {
    const clock = mock.clock(on);
    const saved = new Map<string, unknown>();
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('store.get', ($, e) => ({ value: saved.get(e.key) }));
    on('store.set', ($, e) => {
      saved.set(e.key, e.value);
      return { value: undefined };
    });
    on('agent.list', () => ({ value: [...LISTED_AGENTS] }));
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e);
      return <Text>another band</Text>;
    });

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await clock.advance(250);

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
    await ui.press({ key: 'hide' });

    expect(saved.get('isBandHidden')).toBe(true);
    expect(await ui.find({ type: 'Text', text: /^Agents:/ })).toBeUndefined();
    expect(await ui.find({ type: 'Text', text: 'another band' })).toBeDefined();
    await ui.unmount();
  });

  test('after /clear the saved choice returns on the next turn without settings hooks', async ($, on) => {
    // Each test starts with $.state at its defaults, which is how /clear
    // leaves it. No classic.SessionStart fires here, as where the built-in
    // guard keeps a user-installed mod's classic hooks from running.
    const clock = mock.clock(on);
    on('store.get', ($, e) => ({ value: e.key === 'isBandHidden' ? true : undefined }));
    on('agent.list', () => ({ value: [...LISTED_AGENTS] }));
    on('session.end', ($, e) => ({ sessionId: e.sessionId }));
    on('turn.start', ($, e) => ({ turnId: e.turnId }));
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e);
      return <Text>another band</Text>;
    });

    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } });
    await $.turn.start({ text: 'next prompt', turnId: 'turn-1' });
    await clock.advance(250);

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
    expect(await ui.find({ type: 'Text', text: /^Agents:/ })).toBeUndefined();
    await ui.unmount();
  });

  test('where settings hooks run, the saved choice returns at once', async ($, on) => {
    const clock = mock.clock(on);
    on('store.get', ($, e) => ({ value: e.key === 'isBandHidden' ? true : undefined }));
    on('agent.list', () => ({ value: [...LISTED_AGENTS] }));
    on('classic.SessionStart', () => ({}));
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e);
      return <Text>another band</Text>;
    });

    await $.classic.SessionStart({ source: 'clear' });
    await clock.advance(250);

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' });
    expect(await ui.find({ type: 'Text', text: /^Agents:/ })).toBeUndefined();
    await ui.unmount();
  });

  test('the command answers with text where no pane is placed', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }));

    const answer = await $.command.run({
      command: 'agent-roster',
      args: '',
      origin: { kind: 'sdk' },
      presentation: { isFullscreen: false, columns: 80 },
    });

    expect(answer.text).toBe('No subagents or teammates in this session yet.');
  });
});
