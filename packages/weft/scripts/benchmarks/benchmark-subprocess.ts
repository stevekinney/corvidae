import { createBenchmarkSubprocessEnvironment } from './environment-configuration.ts';

type BenchmarkValidator<TMeasurement> = (value: unknown) => value is TMeasurement;

function decodeBuffer(buffer: Uint8Array): string {
  return new TextDecoder().decode(buffer);
}

export function runBenchmarkSubprocess<TMeasurement>({
  benchmarkName,
  runnerArguments = [],
  runnerPath,
  validateMeasurement,
}: {
  benchmarkName: string;
  runnerArguments?: string[];
  runnerPath: string;
  validateMeasurement: BenchmarkValidator<TMeasurement>;
}): TMeasurement {
  const result = Bun.spawnSync([process.execPath, 'run', runnerPath, ...runnerArguments], {
    cwd: process.cwd(),
    env: createBenchmarkSubprocessEnvironment(),
    stderr: 'pipe',
    stdout: 'pipe',
  });

  if (result.exitCode !== 0) {
    const errorOutput = decodeBuffer(result.stderr).trim();
    throw new Error(`${benchmarkName} subprocess failed: ${errorOutput}`);
  }

  const outputLines = decodeBuffer(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastOutputLine = outputLines.at(-1);
  if (lastOutputLine === undefined) {
    throw new Error(`${benchmarkName} subprocess produced no measurement output`);
  }

  const parsed = JSON.parse(lastOutputLine) as unknown;
  if (!validateMeasurement(parsed)) {
    throw new Error(`${benchmarkName} subprocess returned an invalid measurement payload`);
  }

  return parsed;
}
