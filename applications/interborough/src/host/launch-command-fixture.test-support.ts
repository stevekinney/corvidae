/**
 * A stand-in host for `supervisor.test.ts`: it writes the launch command the supervisor handed it
 * (`INTERBOROUGH_LAUNCH_COMMAND` and `INTERBOROUGH_LAUNCH_DIRECTORY`) as JSON to the file
 * `INTERBOROUGH_LAUNCH_FIXTURE_OUTPUT` names, then exits 0, which ends the supervisor.
 */
import { writeFileSync } from 'node:fs';

import { resolveLaunchCommand } from './launch-command.ts';

const output = process.env['INTERBOROUGH_LAUNCH_FIXTURE_OUTPUT'];
if (output === undefined) throw new Error('The fixture needs INTERBOROUGH_LAUNCH_FIXTURE_OUTPUT.');
writeFileSync(output, JSON.stringify(resolveLaunchCommand(process.env) ?? null));
