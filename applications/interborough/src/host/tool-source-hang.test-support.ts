import { appendFileSync } from 'node:fs';

// A child process for the tool-source manager's deadline tests (COR-1930), run as a script: a stdio
// "server" that never answers the handshake and ignores its stdin closing, so only the host
// stopping it ends it. It appends its process id to the file named by its first argument, one line
// per process (the SDK probes on a short-lived sibling before it starts the session process).
const file = process.argv[2];
if (file === undefined) throw new Error('Expected the file to record the process id in.');
appendFileSync(file, `${process.pid}\n`);
setInterval(() => undefined, 1_000);
