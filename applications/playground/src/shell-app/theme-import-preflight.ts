/**
 * The import preflight (COR-486, R5). It reads text the caller already holds, decides exactly
 * one of four outcomes, and returns what an Apply would commit. It touches no draft, fetches
 * nothing, and evaluates nothing as code. Order matters: resource limits and unsafe-input
 * rejection run before any classification, so a hostile file is refused whatever it claims
 * to be.
 */

import { CINDER_BASE, computeSourceDigest } from '@lostgradient/cinder/tokens/runtime';

import { cinderThemeBase } from './theme-builder-base.ts';
import {
  checkDocumentLimits,
  checkFileSize,
  THEME_DATA_LIMITS,
  type LimitViolation,
} from './theme-draft-limits.ts';
import {
  OVERRIDE_SCOPES,
  THEME_FORMAT,
  THEME_VERSION,
  type JsonObject,
  type ThemeEnvelope,
} from './theme-draft-types.ts';
import { envelopeFromValue, envelopeLimitViolations } from './theme-envelope.ts';
import { recognizeJson5, recognizeParsed, type Recognition } from './theme-import-detect.ts';
import { censusFacts, censusOf, overlayDocument, runtimeFindings } from './theme-import-overlay.ts';
import {
  checkCssOverrideEntries,
  checkDocumentPaths,
  checkPublicTargetTypes,
  checkResolverReferences,
  checkTreeBindings,
  forEachToken,
  isRegistryPath,
  scanStructure,
} from './theme-import-safety.ts';
import type {
  BaseComparison,
  ImportFinding,
  ImportSource,
  PreflightFact,
  PreflightResult,
} from './theme-import-types.ts';

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const limitFinding = (violation: LimitViolation): ImportFinding => ({
  code: violation.code,
  path: violation.location,
  message: `${violation.location} is over a data limit (${violation.actual} against ${violation.limit}).`,
});

function result(
  source: ImportSource,
  partial: Partial<PreflightResult> & Pick<PreflightResult, 'outcome' | 'headline' | 'detail'>,
): PreflightResult {
  return {
    axes: [],
    unsupported: [],
    findings: [],
    facts: [],
    base: null,
    candidate: null,
    source,
    ...partial,
  };
}

function invalid(
  source: ImportSource,
  findings: ImportFinding[],
  detail?: string,
): PreflightResult {
  return result(source, {
    outcome: 'invalid',
    headline: 'Invalid input. Nothing was changed.',
    detail:
      detail ??
      'The file was refused before it touched your draft. Your draft and its preview are exactly as they were. You can download the file unchanged.',
    findings,
  });
}

function unsupported(source: ImportSource, recognition: Recognition): PreflightResult {
  return result(source, {
    outcome: 'unsupported-profile',
    headline: recognition.headline,
    detail: `${recognition.detail} Your draft is unchanged.`,
    axes: recognition.axes,
    unsupported: recognition.unsupported,
  });
}

/** A file over the size limit is refused without reading it into memory. */
export function preflightOversizeFile(file: File): PreflightResult {
  const violation: LimitViolation = {
    code: 'file-too-large',
    location: file.name,
    limit: THEME_DATA_LIMITS.fileBytes,
    actual: file.size,
  };
  return invalid({ file }, [limitFinding(violation)]);
}

function envelopeAxes(envelope: ThemeEnvelope): string[] {
  const resolver = envelope.base.resolver;
  const modifiers =
    isObject(resolver) && isObject(resolver['modifiers']) ? resolver['modifiers'] : {};
  const axes = Object.entries(modifiers).map(([name, modifier]) => {
    const contexts =
      isObject(modifier) && isObject(modifier['contexts']) ? Object.keys(modifier['contexts']) : [];
    return `${name}: ${contexts.join(', ')}`;
  });
  return axes;
}

function envelopeFacts(envelope: ThemeEnvelope): PreflightFact[] {
  const scopes = OVERRIDE_SCOPES.filter(
    (scope) => Object.keys(envelope.overrides[scope]).length > 0,
  );
  let overrides = 0;
  let sourceTokens = 0;
  const seen = new Set<string>();
  for (const scope of OVERRIDE_SCOPES) {
    forEachToken(envelope.overrides[scope], (path) => {
      if (seen.has(path)) return;
      seen.add(path);
      overrides += 1;
      if (!isRegistryPath(path)) sourceTokens += 1;
    });
  }
  return [
    { label: 'Theme name', value: envelope.name },
    { label: 'Scopes with overrides', value: scopes.length === 0 ? 'none' : scopes.join(', ') },
    { label: 'Overridden tokens', value: String(overrides) },
    { label: 'Source tokens (kept, no CSS)', value: String(sourceTokens) },
    { label: 'CSS-only edits', value: String(Object.keys(envelope.cssOverrides).length) },
  ];
}

async function classifyEnvelope(
  parsed: JsonObject,
  source: ImportSource,
): Promise<PreflightResult> {
  if (parsed['version'] !== THEME_VERSION) {
    return unsupported(source, {
      profile: 'dtcg-dialect',
      headline: 'Recognized a Cinder theme with a version this build does not read',
      detail: `The file is a Cinder theme of version ${String(parsed['version'])}; this build reads version ${THEME_VERSION}. It is not rewritten or downgraded.`,
      axes: [],
      unsupported: [`Cinder theme version ${String(parsed['version'])}.`],
    });
  }
  const envelope = envelopeFromValue(parsed);
  if (envelope === null) {
    return invalid(source, [
      {
        code: 'bad-envelope',
        path: '$',
        message:
          'The file says it is a Cinder Theme v1 envelope but is missing required fields (id, name, base, overrides or cssOverrides).',
      },
    ]);
  }
  const findings: ImportFinding[] = [
    ...envelopeLimitViolations(envelope).map(limitFinding),
    ...checkDocumentPaths(Object.keys(envelope.base.documents)),
    ...checkResolverReferences(envelope.base.resolver),
    ...checkCssOverrideEntries(envelope.cssOverrides),
  ];
  for (const scope of OVERRIDE_SCOPES) {
    findings.push(
      ...checkTreeBindings(envelope.overrides[scope], scope),
      ...checkPublicTargetTypes(envelope.overrides[scope], scope),
    );
  }
  if (findings.length > 0) return invalid(source, findings);

  const actual = await computeSourceDigest({
    resolver: envelope.base.resolver,
    documents: envelope.base.documents,
  });
  if (actual !== envelope.base.sourceDigest) {
    return invalid(source, [
      {
        code: 'bad-base-digest',
        path: 'base.sourceDigest',
        message: `The embedded base hashes to ${actual}, not the ${envelope.base.sourceDigest} the file claims. It is not trusted.`,
      },
    ]);
  }
  const comparison: BaseComparison = {
    packageVersion: envelope.base.packageVersion,
    sourceDigest: envelope.base.sourceDigest,
    currentPackageVersion: CINDER_BASE.packageVersion,
    currentSourceDigest: CINDER_BASE.sourceDigest,
  };
  const compatible =
    envelope.base.sourceDigest === CINDER_BASE.sourceDigest &&
    envelope.base.packageVersion === CINDER_BASE.packageVersion;
  const base = { ...comparison, compatible };
  const facts = envelopeFacts(envelope);
  const axes = envelopeAxes(envelope);
  if (!compatible) {
    return result(source, {
      outcome: 'cinder-envelope',
      headline: 'Cinder Theme v1 envelope with an incompatible Cinder base',
      detail: `This theme was written against Cinder ${comparison.packageVersion} (${comparison.sourceDigest}); this build ships ${comparison.currentPackageVersion} (${comparison.currentSourceDigest}). It cannot be previewed or exported here, and it is never rebased silently. It opens read-only: inspect it here and download it unchanged. Your draft is unchanged.`,
      axes,
      facts,
      base,
    });
  }
  const candidate: ThemeEnvelope = { ...envelope, base: cinderThemeBase() };
  const runtime = runtimeFindings(candidate);
  if (runtime.length > 0) return invalid(source, runtime);
  return result(source, {
    outcome: 'cinder-envelope',
    headline: 'Supported Cinder Theme v1 envelope',
    detail:
      'Recognized Cinder Theme v1 written against this build of Cinder. All six contexts validate. Apply replaces your draft in one undoable step, or import it as a copy.',
    axes,
    facts,
    base,
    candidate: { kind: 'envelope', envelope: candidate },
  });
}

function classifyDocument(
  parsed: JsonObject,
  source: ImportSource,
  current: ThemeEnvelope,
): PreflightResult {
  const findings: ImportFinding[] = [
    ...checkTreeBindings(parsed, 'document'),
    ...checkPublicTargetTypes(parsed, 'document'),
  ];
  if (findings.length > 0) return invalid(source, findings);
  const overlay = overlayDocument(current, parsed);
  if (!overlay.ok) return invalid(source, overlay.findings);
  const census = censusOf(parsed);
  return result(source, {
    outcome: 'dtcg-document',
    headline: 'Supported DTCG token document',
    detail:
      'Recognized a DTCG 2025.10 token document. It validates against the schema and the Cinder rules in all six contexts. Apply lays it over your shared overrides in one undoable step; tokens at known Cinder paths override them, and every other token is kept as a Source token with no CSS.',
    axes: ['single document'],
    facts: censusFacts(census),
    candidate: { kind: 'overlay', state: overlay.state, envelope: overlay.envelope },
  });
}

function hasTokens(value: JsonObject): boolean {
  let found = false;
  forEachToken(value, () => {
    found = true;
  });
  return found;
}

/**
 * Decide one outcome for `text`. `current` is the open theme, used only to build the
 * overlay candidate; it is never modified.
 */
export async function preflightImport(
  text: string,
  filename: string,
  current: ThemeEnvelope,
): Promise<PreflightResult> {
  const source: ImportSource = { filename, mime: 'application/json', text };
  const size = checkFileSize(text);
  if (size.length > 0) return invalid(source, size.map(limitFinding));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const json5 = recognizeJson5(text);
    if (json5 !== null) return unsupported(source, json5);
    return invalid(source, [
      {
        code: 'invalid-json',
        path: '$',
        message: error instanceof Error ? error.message : 'The text is not valid JSON.',
      },
    ]);
  }
  if (!isObject(parsed)) {
    return invalid(source, [
      { code: 'not-an-object', path: '$', message: 'The top level must be a JSON object.' },
    ]);
  }
  const unsafe = scanStructure(parsed);
  if (unsafe.length > 0) return invalid(source, unsafe);

  if (parsed['format'] === THEME_FORMAT) return classifyEnvelope(parsed, source);

  const recognized = recognizeParsed(parsed);
  if (recognized !== null) return unsupported(source, recognized);

  const limits = checkDocumentLimitsOf(parsed);
  if (limits.length > 0) return invalid(source, limits);
  if (hasTokens(parsed)) return classifyDocument(parsed, source, current);

  return invalid(
    source,
    [
      {
        code: 'unrecognized',
        path: '$',
        message:
          'This is not a Cinder Theme v1 envelope or a DTCG token document, and no known dialect was recognized.',
      },
    ],
    'The shape is not recognized, so nothing was guessed from the file name. Your draft is unchanged. You can download the file unchanged.',
  );
}

function checkDocumentLimitsOf(document: JsonObject): ImportFinding[] {
  return checkDocumentLimits({ document }).map(limitFinding);
}
