/**
 * COR-2009 (`host:restart`): the supervisor records the terminal command the host was launched
 * with, so a restart that never comes back can say how to start it again.
 */
import { describe, expect, test } from 'bun:test';

import {
  deriveLaunchCommand,
  LAUNCH_COMMAND_VARIABLE,
  LAUNCH_DIRECTORY_VARIABLE,
  launchCommandEnvironment,
  resolveLaunchCommand,
  shellQuote,
} from './launch-command.ts';

const PACKAGE = '/work/corvidae/applications/interborough';
const BUN = '/opt/homebrew/bin/bun';
const SUPERVISOR = `${PACKAGE}/src/host/supervisor.ts`;

/** The environment Bun sets for `bun run <event>` of a script whose text is `script`. */
function packageScript(event: string, script: string) {
  return {
    npm_lifecycle_event: event,
    npm_lifecycle_script: script,
    npm_package_json: `${PACKAGE}/package.json`,
  };
}

describe('deriveLaunchCommand', () => {
  test('is `bun run start` in the package for the start script', () => {
    expect(
      deriveLaunchCommand({
        environment: packageScript('start', 'bun src/host/supervisor.ts serve'),
        argv: [BUN, SUPERVISOR, 'serve'],
        cwd: PACKAGE,
      }),
    ).toEqual({ command: 'bun run start', directory: PACKAGE });
  });

  test('keeps the arguments given after the script’s own', () => {
    expect(
      deriveLaunchCommand({
        environment: packageScript('dev', 'bun src/host/supervisor.ts dev'),
        argv: [BUN, SUPERVISOR, 'dev', '--showcase', '--plugin', '/home/me/my plugin'],
        cwd: PACKAGE,
      }),
    ).toEqual({
      command: "bun run dev --showcase --plugin '/home/me/my plugin'",
      directory: PACKAGE,
    });
  });

  test('is the package’s script whatever directory a filtered run started in', () => {
    expect(
      deriveLaunchCommand({
        environment: packageScript('start', 'bun src/host/supervisor.ts serve'),
        argv: [BUN, SUPERVISOR, 'serve'],
        cwd: '/work/corvidae',
      }),
    ).toEqual({ command: 'bun run start', directory: PACKAGE });
  });

  test('ignores an outer script that ran this one directly', () => {
    expect(
      deriveLaunchCommand({
        environment: packageScript('test', 'bun scripts/bun-test-junit.ts'),
        argv: [BUN, SUPERVISOR, 'serve'],
        cwd: PACKAGE,
      }),
    ).toEqual({ command: 'bun src/host/supervisor.ts serve', directory: PACKAGE });
  });

  test('ignores a script whose arguments are not the ones this process was given', () => {
    expect(
      deriveLaunchCommand({
        environment: packageScript('start', 'bun src/host/supervisor.ts serve'),
        argv: [BUN, SUPERVISOR, 'dev'],
        cwd: PACKAGE,
      }),
    ).toEqual({ command: 'bun src/host/supervisor.ts dev', directory: PACKAGE });
  });

  test('is Bun on the script from the working directory when no package script ran it', () => {
    expect(
      deriveLaunchCommand({ environment: {}, argv: [BUN, SUPERVISOR, 'serve'], cwd: PACKAGE }),
    ).toEqual({ command: 'bun src/host/supervisor.ts serve', directory: PACKAGE });
  });

  test('names a script outside the working directory by its full path', () => {
    expect(
      deriveLaunchCommand({ environment: {}, argv: [BUN, SUPERVISOR, 'serve'], cwd: '/elsewhere' }),
    ).toEqual({ command: `bun ${SUPERVISOR} serve`, directory: '/elsewhere' });
  });
});

describe('shellQuote', () => {
  test('leaves a plain argument alone and quotes one a shell would split or expand', () => {
    expect(['serve', '--plugin=./a', 'a b', "it's", '$HOME'].map(shellQuote)).toEqual([
      'serve',
      '--plugin=./a',
      "'a b'",
      `'it'\\''s'`,
      "'$HOME'",
    ]);
  });
});

describe('the launch command a host is handed', () => {
  test('is read back from the variables the supervisor sets', () => {
    const launch = { command: 'bun run start', directory: PACKAGE };
    expect(resolveLaunchCommand(launchCommandEnvironment(launch))).toEqual(launch);
  });

  test('is absent for a host no supervisor started', () => {
    expect(resolveLaunchCommand({})).toBeUndefined();
    expect(
      resolveLaunchCommand({
        [LAUNCH_COMMAND_VARIABLE]: 'bun run start',
        [LAUNCH_DIRECTORY_VARIABLE]: '',
      }),
    ).toBeUndefined();
  });
});
