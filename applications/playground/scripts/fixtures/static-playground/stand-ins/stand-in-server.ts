/**
 * A stand-in for the static server: the real one, plus a sleeper in its process group and a PID
 * record, so a lifecycle case can kill the server mid-run and prove its descendants go with it.
 *
 *   bun stand-in-server.ts --directory <dir> --port-file <file> --record <dir>
 */
import { join } from 'node:path';

import {
  loadStaticHostConfiguration,
  startStaticServer,
  writePortFile,
} from '../../../static-playground-server.ts';
import { argumentValue, startSleeper } from './stand-in-processes.ts';

const directory = argumentValue('--directory');
const portFile = argumentValue('--port-file');
const record = argumentValue('--record');
if (directory === undefined || portFile === undefined || record === undefined) {
  throw new Error('usage: stand-in-server.ts --directory <dir> --port-file <file> --record <dir>');
}

const server = startStaticServer({ directory, configuration: await loadStaticHostConfiguration() });
await Bun.write(join(record, 'server.pid'), `${process.pid}\n`);
startSleeper(record, 'server-grandchild');
await writePortFile(portFile, server.port);
