/**
 * A stand-in for the static server: the real one, plus a sleeper in its process group and a PID
 * record, so a lifecycle case can kill the server mid-run and prove its descendants go with it.
 *
 *   bun stand-in-server.ts --directory <dir> --port-file <file> --record <dir>
 *
 * `--hold-port` withholds the port file until `<record>/release-port` exists, so a case can kill
 * the server during startup. `--advertise-port <n>` reports port `n` instead of its own, so the
 * gate's preflight talks to a responder the case controls.
 */
import { join } from 'node:path';

import {
  loadStaticHostConfiguration,
  startStaticServer,
  writePortFile,
} from '../../../static-playground-server.ts';
import { argumentValue, startSleeper, waitForFile } from './stand-in-processes.ts';

const directory = argumentValue('--directory');
const portFile = argumentValue('--port-file');
const record = argumentValue('--record');
if (directory === undefined || portFile === undefined || record === undefined) {
  throw new Error('usage: stand-in-server.ts --directory <dir> --port-file <file> --record <dir>');
}

const server = startStaticServer({ directory, configuration: await loadStaticHostConfiguration() });
await Bun.write(join(record, 'server.pid'), `${process.pid}\n`);
startSleeper(record, 'server-grandchild');
if (process.argv.includes('--hold-port')) await waitForFile(join(record, 'release-port'));
const advertised = argumentValue('--advertise-port');
await writePortFile(portFile, advertised === undefined ? server.port : Number(advertised));
