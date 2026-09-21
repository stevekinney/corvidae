import { afterEach, describe, expect, it } from 'bun:test';

import {
  createBenchmarkSubprocessEnvironment,
  resolveBenchmarkEnvironment,
} from './environment-configuration.ts';

const names = [
  'CODEX_CI',
  'GITHUB_ACTIONS',
  'CI',
  'WEFT_SQLITE_ARCHITECTURE_BENCHMARK',
  'WEFT_SEARCH_ATTRIBUTES_ARCHITECTURE_BENCHMARK',
  'WEFT_EVENT_DISPATCH_ARCHITECTURE_BENCHMARK',
  'WEFT_SPECULATION_BENCH_LATENCY_MS',
  'WEFT_COVERAGE_MODE',
  'NODE_V8_COVERAGE',
] as const;
const saved = Object.fromEntries(names.map((name) => [name, Bun.env[name]]));

afterEach(() => {
  for (const name of names) {
    const value = saved[name];
    if (value === undefined) delete Bun.env[name];
    else Bun.env[name] = value;
  }
});

describe('benchmark environment configuration', () => {
  it('preserves boolean flag semantics and refreshes values', () => {
    Bun.env['CODEX_CI'] = '1';
    Bun.env['CI'] = '0';
    Bun.env['WEFT_EVENT_DISPATCH_ARCHITECTURE_BENCHMARK'] = '1';
    expect(resolveBenchmarkEnvironment().codexCi).toBe(true);
    expect(resolveBenchmarkEnvironment().ci).toBe(true);
    expect(resolveBenchmarkEnvironment().eventDispatchArchitectureBenchmark).toBe(true);
    Bun.env['CI'] = '';
    expect(resolveBenchmarkEnvironment().ci).toBe(false);
    delete Bun.env['CODEX_CI'];
    expect(resolveBenchmarkEnvironment().codexCi).toBe(false);
  });

  it('preserves Number conversion semantics, including invalid values', () => {
    Bun.env['WEFT_SPECULATION_BENCH_LATENCY_MS'] = 'not-a-number';
    expect(Number.isNaN(resolveBenchmarkEnvironment().speculationBenchLatencyMs)).toBe(true);
    Bun.env['WEFT_SPECULATION_BENCH_LATENCY_MS'] = 'Infinity';
    expect(resolveBenchmarkEnvironment().speculationBenchLatencyMs).toBe(Infinity);
  });
});

describe('createBenchmarkSubprocessEnvironment', () => {
  it('forwards only the allowlisted subprocess variables, unconverted', () => {
    Bun.env['NODE_V8_COVERAGE'] = '/tmp/coverage-dir';
    Bun.env['WEFT_COVERAGE_MODE'] = '1';
    // Not on the allowlist — must never leak through.
    Bun.env['CODEX_CI'] = '1';

    const forwarded = createBenchmarkSubprocessEnvironment();

    expect(forwarded['NODE_V8_COVERAGE']).toBe('/tmp/coverage-dir');
    expect(forwarded['WEFT_COVERAGE_MODE']).toBe('1');
    expect(forwarded).not.toHaveProperty('CODEX_CI');
  });

  it('omits an allowlisted variable entirely when it is unset, rather than forwarding undefined', () => {
    delete Bun.env['WEFT_COVERAGE_MODE'];

    const forwarded = createBenchmarkSubprocessEnvironment();

    expect(forwarded).not.toHaveProperty('WEFT_COVERAGE_MODE');
  });
});
