import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import type { AttachmentGrant } from '@lostgradient/ventriloquist';
import type { LaunchSnapshot } from '@lostgradient/ventriloquist/websocket';

import type { ProfileIdentifier } from '../shared/profile-catalog.ts';
import type { HostEnvironment } from './environment-configuration.ts';

/** The terminal size every PTY starts at. The page sends its measured size once it is attached. */
export const DEFAULT_DIMENSIONS = { columns: 80, rows: 24 } as const;

const FIXTURES = join(import.meta.dirname, 'fixtures');
export const REPLAY_FIXTURE = join(FIXTURES, 'replay.ansi');
export const FULLSCREEN_PROGRAM = join(FIXTURES, 'fullscreen.sh');
export const DIAGNOSTIC_PROGRAM = join(FIXTURES, 'diagnostic.sh');
export const ESCAPED_PROGRAM = join(FIXTURES, 'escaped.sh');
export const LINKS_FIXTURE = join(FIXTURES, 'links.ansi');

/** Who the shell runs as, read from the operating system rather than from the page. */
export type LocalUser = {
  readonly username: string;
  readonly homeDirectory: string;
  /** The login shell the account database records, if it records one. */
  readonly shell: string | undefined;
};

export type ProfileContext = {
  readonly host: HostEnvironment;
  readonly user: LocalUser;
};

export type ResolvedProfile = {
  readonly grant: AttachmentGrant;
  readonly launch: LaunchSnapshot;
};

export function localUser(): LocalUser {
  const account = userInfo();
  return {
    username: account.username,
    homeDirectory: account.homedir || homedir(),
    shell: typeof account.shell === 'string' ? account.shell : undefined,
  };
}

const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function programEnvironment(context: ProfileContext): Record<string, string> {
  return {
    TERM: 'xterm-256color',
    PATH: SAFE_PATH,
    LANG: context.host.language ?? 'en_US.UTF-8',
  };
}

/**
 * The login shell: `$SHELL`, or the account's recorded shell when `$SHELL` is unset. It must be an
 * absolute path. There is no fallback to another shell, because a missing shell is a startup
 * failure to report, not a reason to run something the person did not choose.
 */
export function loginShell(context: ProfileContext): string | undefined {
  const chosen = context.host.shell ?? context.user.shell;
  return chosen !== undefined && chosen.startsWith('/') ? chosen : undefined;
}

/**
 * Decide what a profile identifier runs. Everything here is the server's: the page named an
 * identifier and a mode and nothing else, so it cannot send an executable, an argument, a
 * directory or an environment. A profile that cannot run on this host (no login shell) is
 * `undefined`, which the caller reports as unavailable.
 *
 * A profile with no input channel is granted read-only whatever the page asked for.
 */
export function resolveProfile(
  identifier: ProfileIdentifier,
  readOnly: boolean,
  context: ProfileContext,
): ResolvedProfile | undefined {
  const grant: AttachmentGrant = readOnly ? 'read-only' : 'interactive';
  switch (identifier) {
    case 'shell': {
      const shell = loginShell(context);
      if (shell === undefined) return undefined;
      return {
        grant,
        launch: {
          mode: 'pty',
          profile: {
            executable: shell,
            argumentList: ['-l'],
            workingDirectory: context.user.homeDirectory,
            environment: {
              ...programEnvironment(context),
              COLORTERM: 'truecolor',
              HOME: context.user.homeDirectory,
              USER: context.user.username,
              LOGNAME: context.user.username,
              SHELL: shell,
              ...(context.host.path === undefined ? {} : { PATH: context.host.path }),
            },
          },
          dimensions: DEFAULT_DIMENSIONS,
        },
      };
    }
    case 'fullscreen':
      return {
        grant,
        launch: {
          mode: 'pty',
          profile: {
            executable: '/bin/sh',
            argumentList: [FULLSCREEN_PROGRAM],
            workingDirectory: FIXTURES,
            environment: programEnvironment(context),
          },
          dimensions: DEFAULT_DIMENSIONS,
        },
      };
    case 'diagnostic':
      return {
        grant: 'read-only',
        launch: {
          mode: 'pipe',
          profile: {
            executable: '/bin/sh',
            argumentList: [DIAGNOSTIC_PROGRAM],
            workingDirectory: FIXTURES,
            environment: programEnvironment(context),
          },
          dimensions: DEFAULT_DIMENSIONS,
          acceptsInput: false,
        },
      };
    case 'escaped':
      return {
        grant,
        launch: {
          mode: 'pty',
          profile: {
            executable: '/bin/sh',
            argumentList: [ESCAPED_PROGRAM],
            workingDirectory: FIXTURES,
            environment: programEnvironment(context),
          },
          dimensions: DEFAULT_DIMENSIONS,
        },
      };
    case 'readonly-output':
    case 'links':
      return {
        grant: 'read-only',
        launch: {
          mode: 'pipe',
          profile: {
            executable: '/bin/cat',
            argumentList: [identifier === 'links' ? LINKS_FIXTURE : REPLAY_FIXTURE],
            workingDirectory: FIXTURES,
            environment: programEnvironment(context),
          },
          dimensions: DEFAULT_DIMENSIONS,
          acceptsInput: false,
        },
      };
  }
}
