/**
 * What the composer says: the blocked row that replaces its text box, in the order the reasons
 * take precedence, and the line under it.
 */
import { describe, expect, test } from 'bun:test';

import { composerStatusOf, type ComposerFacts } from './composer-state.ts';

const QUIET: ComposerFacts = {
  unreachable: false,
  restarting: false,
  ended: false,
  noProvider: false,
  connectHref: '/settings/models',
  newChatHref: '/chats/new',
  reconnectAttempt: 0,
  queuedFollowUps: 0,
  working: false,
};

const facts = (overrides: Partial<ComposerFacts>): ComposerFacts => ({ ...QUIET, ...overrides });

describe('a blocked composer', () => {
  test('says sending is off until the server is reachable, with no action, since Retry lives in the banner', () => {
    expect(composerStatusOf(facts({ unreachable: true }))).toEqual({
      kind: 'blocked',
      reason: 'Sending is off until Interborough is reachable',
    });
  });

  test('says sending resumes when Interborough is back, with no action, while the host restarts', () => {
    expect(composerStatusOf(facts({ restarting: true }))).toEqual({
      kind: 'blocked',
      reason: 'Sending resumes when Interborough is back.',
    });
  });

  test('names the agent and the plugin once, with Enable and restart', () => {
    let enabled = 0;
    const status = composerStatusOf(
      facts({
        unavailable: { agent: 'Release helper', plugin: 'Demo', enable: () => (enabled += 1) },
      }),
    );

    expect(status).toMatchObject({
      kind: 'blocked',
      reason: 'Release helper isn’t available. Enable the Demo plugin to continue.',
      action: { label: 'Enable and restart' },
    });
    if (status?.kind !== 'blocked') throw new Error('The composer is not blocked.');
    status.action?.onclick?.();
    expect(enabled).toBe(1);
  });

  test('says a chat the server stopped when it restarted has ended, with New chat', () => {
    expect(composerStatusOf(facts({ ended: true }))).toEqual({
      kind: 'blocked',
      reason: 'This chat has ended. The server stopped it when it restarted.',
      action: { label: 'New chat', href: '/chats/new' },
    });
  });

  test('asks to connect a provider, and offers Use Assistant only where Assistant can be chosen', () => {
    expect(composerStatusOf(facts({ noProvider: true }))).toEqual({
      kind: 'blocked',
      reason: 'Connect a model provider to chat',
      action: { label: 'Connect a provider', href: '/settings/models' },
    });

    let switched = 0;
    const withLink = composerStatusOf(
      facts({ noProvider: true, useAssistant: () => (switched += 1) }),
    );
    if (withLink?.kind !== 'blocked') throw new Error('The composer is not blocked.');
    expect(withLink.link?.label).toBe('Use Assistant');
    withLink.link?.onclick?.();
    expect(switched).toBe(1);
  });

  test('says the first reason that holds, because each makes the later ones moot', () => {
    const everything = facts({
      unreachable: true,
      restarting: true,
      unavailable: { agent: 'A', plugin: 'P', enable: () => undefined },
      ended: true,
      noProvider: true,
      reconnectAttempt: 2,
    });

    expect(composerStatusOf(everything)).toMatchObject({
      reason: expect.stringContaining('reachable'),
    });
    expect(composerStatusOf({ ...everything, unreachable: false })).toMatchObject({
      reason: 'Sending resumes when Interborough is back.',
    });
    expect(
      composerStatusOf({ ...everything, unreachable: false, restarting: false }),
    ).toMatchObject({
      action: { label: 'Enable and restart' },
    });
    const noPlugin = {
      ...everything,
      unreachable: false,
      restarting: false,
      unavailable: undefined,
    };
    expect(composerStatusOf(noPlugin)).toMatchObject({ action: { label: 'New chat' } });
    expect(composerStatusOf({ ...noPlugin, ended: false })).toMatchObject({
      action: { label: 'Connect a provider' },
    });
  });
});

describe('the line under the composer', () => {
  test('is nothing, so the hint shows, for a quiet chat', () => {
    expect(composerStatusOf(QUIET)).toBeUndefined();
  });

  test('says a message now steers the run while the chat is working', () => {
    expect(composerStatusOf(facts({ working: true }))).toEqual({ kind: 'steering' });
  });

  test('counts the reconnect attempts while the stream is being read again', () => {
    expect(composerStatusOf(facts({ working: true, reconnectAttempt: 3 }))).toEqual({
      kind: 'reconnecting',
      attempt: 3,
    });
  });

  test('says a follow-up is queued, ahead of a setting note and of steering', () => {
    expect(
      composerStatusOf(facts({ working: true, queuedFollowUps: 1, note: 'Effort High applies.' })),
    ).toEqual({ kind: 'queued', count: 1 });
  });

  test('says when a changed setting applies, ahead of steering', () => {
    expect(
      composerStatusOf(facts({ working: true, note: 'Effort High applies from the next step.' })),
    ).toEqual({ kind: 'note', text: 'Effort High applies from the next step.' });
  });
});
