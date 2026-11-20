import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { handleHookEvent, type HookInput } from '../host-sessions.ts';
import { contextFenceTokens } from './context-fence.ts';
import { context, lease, transcript, world } from './session-fences.test-support.ts';

describe('the context fence', () => {
  const dispatch = (transcriptPath: string, extra: Partial<HookInput> = {}): HookInput => ({
    hook_event_name: 'PreToolUse',
    session_id: 'coordinator',
    // Workflow takes no host place, so an allowed call prints nothing; an allowed Agent call is
    // admitted (or reported as unplaced) by the place cap, which these tests do not exercise.
    tool_name: 'Workflow',
    tool_use_id: 'tool-1',
    transcript_path: transcriptPath,
    tool_input: { subagent_type: 'chef-worker', description: 'Deliver COR-1', prompt: 'Go.' },
    ...extra,
  });

  test('denies a leased coordinator whose last call held 210K tokens', async () => {
    const setting = await world();
    await lease(setting, 'coordinator');
    const path = await transcript(setting, 'coordinator', [50_000, 210_000]);
    for (const tool of ['Agent', 'Workflow', 'mcp__ccd_session__start_session']) {
      const output = await handleHookEvent(dispatch(path, { tool_name: tool }), context(setting));
      expect(output?.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain('compact');
    }
  });

  test('allows a worker, which shares its coordinator session but carries an agent_id', async () => {
    const setting = await world();
    await lease(setting, 'coordinator');
    const path = await transcript(setting, 'worker', [210_000]);
    const output = await handleHookEvent(
      dispatch(path, { agent_id: 'agent-9', agent_type: 'chef-worker', tool_name: 'Workflow' }),
      context(setting),
    );
    expect(output).toBeUndefined();
  });

  test('allows an unleased session at any size', async () => {
    const setting = await world();
    const path = await transcript(setting, 'unleased', [600_000]);
    expect(
      await handleHookEvent(dispatch(path, { session_id: 'groom' }), context(setting)),
    ).toBeUndefined();
  });

  test('allows a coordinator once it compacts: the last call is measured, not the peak', async () => {
    const setting = await world();
    await lease(setting, 'coordinator');
    const path = await transcript(setting, 'compacted', [210_000, 30_000]);
    expect(await handleHookEvent(dispatch(path), context(setting))).toBeUndefined();
  });

  test('allows a context at the limit and fails open, with a logged reason, on a missing transcript', async () => {
    const setting = await world();
    await lease(setting, 'coordinator');
    const at = await transcript(setting, 'at-limit', [contextFenceTokens]);
    expect(await handleHookEvent(dispatch(at), context(setting))).toBeUndefined();
    const logged: string[] = [];
    const missing = await handleHookEvent(
      dispatch(join(setting.root, 'absent.jsonl')),
      context(setting, { report: (lines) => logged.push(...lines) }),
    );
    expect(missing).toBeUndefined();
    expect(logged.join('\n')).toContain('could not be read');
    logged.length = 0;
    await handleHookEvent(
      { ...dispatch(''), transcript_path: undefined },
      context(setting, { report: (lines) => logged.push(...lines) }),
    );
    expect(logged.join('\n')).toContain('no transcript_path');
  });

  test('is registered for every fenced tool', () => {
    const settings = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '.claude', 'settings.json'), 'utf8'),
    ) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    for (const tool of ['Agent', 'Workflow', 'mcp__ccd_session__start_session']) {
      expect(
        (settings.hooks['PreToolUse'] ?? []).some(
          (group) =>
            group.matcher?.split('|').includes(tool) === true &&
            group.hooks.some((hook) => hook.command.includes('scripts/host-sessions.ts hook')),
        ),
      ).toBe(true);
    }
  });
});
