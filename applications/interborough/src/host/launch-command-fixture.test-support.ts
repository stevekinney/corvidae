/**
 * A stand-in host for `supervisor.test.ts`: it writes the launch command the supervisor handed it
 * (`INTERBOROUGH_LAUNCH_COMMAND` and `INTERBOROUGH_LAUNCH_DIRECTORY`) as JSON to the file
 * `INTERBOROUGH_LAUNCH_FIXTURE_OUTPUT` names, then exits 0, which ends the supervisor.
 */
import { writeFileSync } from 'node:fs';

import { processEnvironment } from './environment-configuration.ts';
import { resolveLaunchCommand } from './launch-command.ts';

const environment = processEnvironment();
const output = environment['INTERBOROUGH_LAUNCH_FIXTURE_OUTPUT'];
if (output === undefined) throw new Error('The fixture needs INTERBOROUGH_LAUNCH_FIXTURE_OUTPUT.');
writeFileSync(output, JSON.stringify(resolveLaunchCommand(environment) ?? null));
