import { appendFileSync } from 'node:fs';

// A stdio MCP server for the tool-source removal test (COR-1931), run as a script: it records its
// process id in the file named by its first argument, then runs Armorer's stdio fixture
// (`packages/armorer/test/fixtures/tool-source-stdio-server.ts`, named by the second) in the same
// process, so the test can tell whether the host stopped the very process that served the tool.
const [file, fixture] = process.argv.slice(2);
if (file === undefined || fixture === undefined) {
  throw new Error('Expected the file to record the process id in, and the fixture to run.');
}
appendFileSync(file, `${process.pid}\n`);
await import(fixture);
