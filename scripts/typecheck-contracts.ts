import { resolve } from 'node:path';
import ts from 'typescript';

const directory = process.cwd();
const configurationPath = resolve(directory, 'tsconfig.json');
const loaded = ts.readConfigFile(configurationPath, (path) => ts.sys.readFile(path));
if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
const configuration = ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => directory,
  getNewLine: () => '\n',
};
let failureCount = 0;

// Registry augmentation fixtures need separate TypeScript programs: their global
// declarations must not change the API seen by unrelated runtime tests.
const contracts = [...new Bun.Glob('{src,tests}/**/*.test-d.ts').scanSync(directory)].toSorted();
for (const contract of contracts) {
  const program = ts.createProgram([resolve(directory, contract)], configuration.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    failureCount += diagnostics.length;
    process.stderr.write(ts.formatDiagnostics(diagnostics, formatHost));
  }
}

for (const path of new Bun.Glob('src/**/__fixtures__/**/tsconfig.json').scanSync(directory)) {
  const result = Bun.spawnSync(['bun', 'x', 'tsc', '--noEmit', '--project', path], {
    cwd: directory,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) failureCount += 1;
}

process.stdout.write(
  `Checked ${contracts.length} isolated type contracts; ${failureCount} errors.\n`,
);
process.exitCode = failureCount > 0 ? 1 : 0;
