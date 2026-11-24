/**
 * What the composer says: the blocked row that replaces its text box, in the order the reasons
 * take precedence, and the line under it.
 */
import { describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy/chat.ts';
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

describe('an unreachable server (COR-2284 C5)', () => {
  test('is the offline warning drawer above the box, which keeps the draft and turns Send off, not a blocked row', () => {
    expect(composerStatusOf(facts({ unreachable: true }))).toEqual({ kind: 'offline' });
  });
});

describe('a blocked composer', () => {
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

  test('keeps the chat of a disabled agent read-only, with Enable agent (COR-2429)', () => {
    let enabled = 0;
    const status = composerStatusOf(
      facts({ disabledAgent: { agent: 'Tool runner', enable: () => (enabled += 1) } }),
    );

    expect(status).toMatchObject({
      kind: 'blocked',
      reason: 'Tool runner is disabled, so this chat is read-only. Enable it to continue.',
      action: { label: 'Enable agent' },
    });
    if (status?.kind !== 'blocked') throw new Error('The composer is not blocked.');
    status.action?.onclick?.();
    expect(enabled).toBe(1);
  });

  test('says no agent can create workflows once, with a link to Agents', () => {
    expect(
      composerStatusOf(facts({ noWorkflowAgent: true, agentsHref: '/agents', noProvider: true })),
    ).toEqual({
      kind: 'blocked',
      reason:
        'No agent can create workflows. Add the Create workflow tool to an agent’s Access tab.',
      action: { label: 'Open Agents', href: '/agents' },
    });
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

    expect(composerStatusOf(everything)).toEqual({ kind: 'offline' });
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

describe('an archived chat (COR-2285 V5)', () => {
  test('is the Archived bar with its date, a secondary New chat and a primary Unarchive', () => {
    let unarchived = 0;
    const status = composerStatusOf(
      facts({ archived: { when: 'Nov 3', unarchive: () => (unarchived += 1) } }),
    );

    expect(status).toMatchObject({
      kind: 'archived',
      when: 'Nov 3',
      newChat: { label: 'New chat', href: '/chats/new' },
      unarchive: { label: 'Unarchive', primary: true },
    });
    if (status?.kind !== 'archived') throw new Error('The composer is not archived.');
    expect(status.newChat?.primary).toBeUndefined();
    status.unarchive?.onclick?.();
    expect(unarchived).toBe(1);
  });

  test('outranks a disabled plugin, an ended chat, no provider and every line under the box', () => {
    const archived = { when: 'Nov 3', unarchive: () => undefined };
    expect(
      composerStatusOf(
        facts({
          archived,
          unavailable: { agent: 'A', plugin: 'P', enable: () => undefined },
          ended: true,
          noProvider: true,
          noWorkflowAgent: true,
          reconnectAttempt: 2,
          queuedFollowUps: 1,
          note: 'Effort High applies.',
          working: true,
        }),
      ),
    ).toMatchObject({ kind: 'archived' });
  });

  test('gives way to an unreachable server and a restarting host, since Unarchive is a write', () => {
    const archived = { when: 'Nov 3', unarchive: () => undefined };
    expect(composerStatusOf(facts({ archived, unreachable: true }))).toEqual({ kind: 'offline' });
    expect(composerStatusOf(facts({ archived, restarting: true }))).toEqual({
      kind: 'blocked',
      reason: 'Sending resumes when Interborough is back.',
    });
  });
});

describe('the line under the composer', () => {
  test('is nothing, so the hint shows, for a quiet chat', () => {
    expect(composerStatusOf(QUIET)).toBeUndefined();
  });

  test('says a message sent now waits for the run to finish while the chat is working, never that it steers the run', () => {
    const status = composerStatusOf(facts({ working: true }));
    expect(status).toEqual({ kind: 'note', text: CHAT_COPY.composer.working });
    expect(CHAT_COPY.composer.working).toBe('A message sent now waits until this run finishes.');
    expect(status?.kind).not.toBe('steering');
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

  test('says when a changed setting applies, ahead of the working line', () => {
    expect(
      composerStatusOf(facts({ working: true, note: 'Effort High applies from the next step.' })),
    ).toEqual({ kind: 'note', text: 'Effort High applies from the next step.' });
  });
});

describe('a draft put back from the draft store (COR-2284 C7)', () => {
  test('is the draft-restored drawer with when the draft was written, and Discard draft forgets it', () => {
    let discarded = 0;
    const status = composerStatusOf(
      facts({ restoredDraft: { when: 'yesterday at 4:12 PM', discard: () => (discarded += 1) } }),
    );

    expect(status).toMatchObject({ kind: 'draft-restored', when: 'yesterday at 4:12 PM' });
    if (status?.kind !== 'draft-restored') throw new Error('No draft-restored drawer.');
    status.ondiscard?.();
    expect(discarded).toBe(1);
  });

  test('gives way to the offline drawer, a blocked row and the reconnect count, and outranks the lines under the box', () => {
    const restoredDraft = { when: '10:42 AM', discard: () => undefined };
    expect(composerStatusOf(facts({ restoredDraft, unreachable: true }))).toEqual({
      kind: 'offline',
    });
    expect(composerStatusOf(facts({ restoredDraft, ended: true }))).toMatchObject({
      kind: 'blocked',
    });
    expect(composerStatusOf(facts({ restoredDraft, reconnectAttempt: 2 }))).toMatchObject({
      kind: 'reconnecting',
    });
    expect(
      composerStatusOf(facts({ restoredDraft, queuedFollowUps: 1, note: 'n', working: true })),
    ).toMatchObject({ kind: 'draft-restored' });
  });
});
