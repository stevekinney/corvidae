import { resolveBenchmarkEnvironment } from './environment-configuration.ts';

export function isCoverageInstrumentationEnabled(): boolean {
  const environment = resolveBenchmarkEnvironment();
  if (environment.coverageMode) {
    return true;
  }

  if (process.execArgv.includes('--coverage')) {
    return true;
  }

  const coverageDirectory = environment.nodeV8Coverage;
  return typeof coverageDirectory === 'string' && coverageDirectory.length > 0;
}
