import type { Environment } from '@lostgradient/environmentalist';
import {
  createEnvironmentRecordSource,
  environmentalist,
  secret,
} from '@lostgradient/environmentalist';
import { z } from 'zod';

const engineSchema = z.object({
  weftDevWarnings: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_DEV_WARNINGS' }),
  nodeEnv: z.string().optional().meta({ env: 'NODE_ENV' }),
});
export type EngineEnvironment = Environment<typeof engineSchema>;
export function resolveEngineEnvironment(): EngineEnvironment {
  return environmentalist.sync({
    name: 'weft-engine',
    schema: engineSchema,
    sources: [createEnvironmentRecordSource({ schema: engineSchema }), 'defaults'],
    argv: [],
    coerce: false,
  });
}

const cliSchema = z.object({
  weftToken: secret(z.string().optional()).meta({ env: 'WEFT_TOKEN' }),
  weftAddr: z.string().optional().meta({ env: 'WEFT_ADDR' }),
  weftProfile: z.string().optional().meta({ env: 'WEFT_PROFILE' }),
  weftHome: z.string().optional().meta({ env: 'WEFT_HOME' }),
  home: z.string().optional().meta({ env: 'HOME' }),
  noColor: z.string().optional().meta({ env: 'NO_COLOR' }),
  forceColor: z.string().optional().meta({ env: 'FORCE_COLOR' }),
  path: z.string().optional().meta({ env: 'PATH' }),
  tmpdir: z.string().optional().meta({ env: 'TMPDIR' }),
  temp: z.string().optional().meta({ env: 'TEMP' }),
  tmp: z.string().optional().meta({ env: 'TMP' }),
  tz: z.string().optional().meta({ env: 'TZ' }),
  nodeEnv: z.string().optional().meta({ env: 'NODE_ENV' }),
});
export type CliEnvironment = Environment<typeof cliSchema>;
export function resolveCliEnvironment(): CliEnvironment {
  return environmentalist.sync({
    name: 'weft-cli',
    schema: cliSchema,
    sources: [createEnvironmentRecordSource({ schema: cliSchema }), 'defaults'],
    argv: [],
    coerce: false,
  });
}

const serverSchema = z.object({
  weftServerAuthenticationRequired: z
    .string()
    .optional()
    .meta({ env: 'WEFT_SERVER_AUTHENTICATION_REQUIRED' }),
  nodeEnv: z.string().optional().meta({ env: 'NODE_ENV' }),
  weftAllowUntrustedApiCatalogOrigin: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN' }),
  weftStrictFaults: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_STRICT_FAULTS' }),
});
export type ServerEnvironment = Environment<typeof serverSchema>;
export function resolveServerEnvironment(): ServerEnvironment {
  return environmentalist.sync({
    name: 'weft-server',
    schema: serverSchema,
    sources: [createEnvironmentRecordSource({ schema: serverSchema }), 'defaults'],
    argv: [],
    coerce: false,
  });
}

/** Read one exact environment variable name for dynamic credential lookup. */
export function readEnvironmentVariable(name: string): string | undefined {
  const schema = z.object({ value: secret(z.string().optional()).meta({ env: name }) });
  return environmentalist.sync({
    name: 'weft-dynamic-secret',
    schema,
    sources: [createEnvironmentRecordSource({ schema }), 'defaults'],
    argv: [],
    coerce: false,
  }).value;
}
