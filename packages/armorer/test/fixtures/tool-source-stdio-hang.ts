import { appendFileSync } from 'node:fs';

// A child process for the tool-source loader's abort test: a stdio "server" that never answers the
// handshake and ignores its stdin closing, so only a signal stops it. It appends its process id to
// the file named by its first argument, one line per process, so the test can see who was started.
const file = process.argv[2];
if (file === undefined) throw new Error('Expected the file to record the process id in.');
appendFileSync(file, `${process.pid}\n`);
setInterval(() => undefined, 1_000);
