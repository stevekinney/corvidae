import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import { PROFILE_DESCRIPTIONS, PROFILE_IDENTIFIERS } from '../shared/profile-catalog.ts';
import {
  DIAGNOSTIC_PROGRAM,
  ESCAPED_PROGRAM,
  FULLSCREEN_PROGRAM,
  LINKS_FIXTURE,
  loginShell,
  REPLAY_FIXTURE,
  resolveProfile,
  type ProfileContext,
} from './profiles.ts';

const context: ProfileContext = {
  host: { shell: '/bin/zsh', path: '/opt/tools/bin:/usr/bin', language: 'fr_FR.UTF-8' },
  user: { username: 'ada', homeDirectory: '/home/ada', shell: '/bin/bash' },
};

describe('the profile table', () => {
  test('names exactly the profiles the page can choose, each with a description and no command', () => {
    expect(PROFILE_IDENTIFIERS.toSorted()).toEqual([
      'diagnostic',
      'escaped',
      'fullscreen',
      'links',
      'readonly-output',
      'shell',
    ]);
    for (const identifier of PROFILE_IDENTIFIERS) {
      const description = PROFILE_DESCRIPTIONS[identifier];
      expect(description.identifier).toBe(identifier);
      expect(JSON.stringify(description)).not.toMatch(/\/bin\/|argumentList|executable/);
    }
  });

  test('the login shell is $SHELL with -l on a pseudo-terminal, in the user home', () => {
    const resolved = resolveProfile('shell', false, context);
    expect(resolved?.grant).toBe('interactive');
    expect(resolved?.launch.mode).toBe('pty');
    expect(resolved?.launch.profile.executable).toBe('/bin/zsh');
    expect(resolved?.launch.profile.argumentList).toEqual(['-l']);
    expect(resolved?.launch.profile.workingDirectory).toBe('/home/ada');
  });

  test('the shell environment is explicit: named values and nothing inherited', () => {
    const environment = resolveProfile('shell', false, context)?.launch.profile.environment;
    expect(environment).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PATH: '/opt/tools/bin:/usr/bin',
      LANG: 'fr_FR.UTF-8',
      HOME: '/home/ada',
      USER: 'ada',
      LOGNAME: 'ada',
      SHELL: '/bin/zsh',
    });
  });

  test('read-only is a grant the page can ask for on a profile that takes input', () => {
    expect(resolveProfile('shell', true, context)?.grant).toBe('read-only');
    expect(resolveProfile('fullscreen', true, context)?.grant).toBe('read-only');
    expect(resolveProfile('fullscreen', false, context)?.grant).toBe('interactive');
  });

  test('the full-screen program is a committed script on a pseudo-terminal', () => {
    const launch = resolveProfile('fullscreen', false, context)?.launch;
    expect(launch?.mode).toBe('pty');
    expect(launch?.profile.executable).toBe('/bin/sh');
    expect(launch?.profile.argumentList).toEqual([FULLSCREEN_PROGRAM]);
    expect(readFileSync(FULLSCREEN_PROGRAM, 'utf8')).toContain('?1049h');
  });

  test('the pipe demo and the replay are pipes that are never granted input', () => {
    for (const identifier of ['diagnostic', 'readonly-output', 'links'] as const) {
      // Whatever the page asked for.
      for (const readOnly of [false, true]) {
        const resolved = resolveProfile(identifier, readOnly, context);
        expect(resolved?.grant).toBe('read-only');
        expect(resolved?.launch.mode).toBe('pipe');
        expect(resolved?.launch.acceptsInput).toBe(false);
      }
    }
    expect(resolveProfile('diagnostic', false, context)?.launch.profile.argumentList).toEqual([
      DIAGNOSTIC_PROGRAM,
    ]);
    expect(resolveProfile('readonly-output', false, context)?.launch.profile).toMatchObject({
      executable: '/bin/cat',
      argumentList: [REPLAY_FIXTURE],
    });
  });

  test('the escaped job is a committed script that leaves the session through perl, not a shell setsid', () => {
    const launch = resolveProfile('escaped', false, context)?.launch;
    expect(launch?.mode).toBe('pty');
    expect(launch?.profile.argumentList).toEqual([ESCAPED_PROGRAM]);
    const program = readFileSync(ESCAPED_PROGRAM, 'utf8');
    expect(program).toStartWith('#!/bin/sh\n');
    expect(program).toContain('POSIX::setsid()');
    expect(program).toContain('escaped=$$');
  });

  test('the links fixture carries every kind of address the review needs', () => {
    expect(resolveProfile('links', false, context)?.launch.profile).toMatchObject({
      executable: '/bin/cat',
      argumentList: [LINKS_FIXTURE],
    });
    const text = readFileSync(LINKS_FIXTURE, 'utf8');
    expect(text).toContain('https://example.com/visible-link');
    expect(text).toContain('\u001b]8;;https://hidden.example/secret\u001b\\');
    expect(text).toContain('/etc/hosts');
    expect(text).toContain('command:workbench.action.openSettings');
    expect(text).toContain('archive.zip?download=1');
  });

  test('every committed program and fixture exists, and the programs are executable by sh', () => {
    for (const path of [REPLAY_FIXTURE, LINKS_FIXTURE, FULLSCREEN_PROGRAM, DIAGNOSTIC_PROGRAM]) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).isFile()).toBe(true);
    }
    for (const path of [FULLSCREEN_PROGRAM, DIAGNOSTIC_PROGRAM, ESCAPED_PROGRAM]) {
      expect(readFileSync(path, 'utf8')).toStartWith('#!/bin/sh\n');
    }
  });

  test('programs other than the shell get a fixed environment and no host values but the locale', () => {
    for (const identifier of [
      'fullscreen',
      'diagnostic',
      'readonly-output',
      'links',
      'escaped',
    ] as const) {
      expect(resolveProfile(identifier, false, context)?.launch.profile.environment).toEqual({
        TERM: 'xterm-256color',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'fr_FR.UTF-8',
      });
    }
  });
});

describe('the login shell', () => {
  test('falls back to the account shell only when $SHELL is unset', () => {
    expect(loginShell({ ...context, host: { ...context.host, shell: undefined } })).toBe(
      '/bin/bash',
    );
    expect(loginShell(context)).toBe('/bin/zsh');
  });

  test('is never a relative name, and a profile without one is unavailable', () => {
    const relative: ProfileContext = {
      host: { shell: 'zsh', path: undefined, language: undefined },
      user: { ...context.user, shell: undefined },
    };
    expect(loginShell(relative)).toBeUndefined();
    expect(resolveProfile('shell', false, relative)).toBeUndefined();
    // The other profiles do not depend on it.
    expect(resolveProfile('fullscreen', false, relative)).toBeDefined();
  });

  test('uses the default locale and the host path when it has them', () => {
    const bare: ProfileContext = {
      host: { shell: '/bin/sh', path: undefined, language: undefined },
      user: context.user,
    };
    const environment = resolveProfile('shell', false, bare)?.launch.profile.environment;
    expect(environment?.['LANG']).toBe('en_US.UTF-8');
    expect(environment?.['PATH']).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('the replay fixture', () => {
  test('is the same bytes every time', () => {
    const digest = createHash('sha256').update(readFileSync(REPLAY_FIXTURE)).digest('hex');
    expect(digest).toBe('0e48add1cbe337d6c60403714ace7b7e3fb78bf74c8405f83d2cc0e71ddd010c');
  });

  test('carries colour, Unicode, a carriage-return rewrite and enough lines to scroll', () => {
    const text = readFileSync(REPLAY_FIXTURE, 'utf8');
    expect(text).toContain('\u001b[32m');
    expect(text).toContain('café');
    expect(text).toContain('\r\u001b[2Kprogress 100%');
    expect(text.split('\r\n').length).toBeGreaterThan(40);
  });
});
