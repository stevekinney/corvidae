/**
 * Check the authored `{name}.constraints.json` of every component.
 *
 * For every component directory that holds one, the document must:
 *
 *  1. have the document shape (id is the kebab-case directory name, rule ids are unique, severity
 *     and combinator values are in their closed sets, every predicate is exactly one shape);
 *  2. name `../../schemas/constraints.schema.json` as its `$schema`;
 *  3. name only props and snippets the component has (the prop cross-check): its generated
 *     `{name}.schema.json` lists them, in `properties` or `metadata.unsupportedProps`.
 *
 * Usage:
 *   bun scripts/check-component-constraints.ts
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import type {
  Combinator,
  ConstraintsDocument,
  ConstraintSeverity,
  Predicate,
} from '../src/_internal/constraints.ts';
import { discoverComponentDirectories } from './discover-component-directories.ts';
import { isObjectRecord } from './validation-utilities.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_REF = '../../schemas/constraints.schema.json';
const VALID_SEVERITIES = new Set<ConstraintSeverity>(['error', 'warning', 'info']);
const VALID_COMBINATORS = new Set<Combinator>(['exactlyOne', 'anyOf', 'allOf', 'requires']);
const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isConstraintsDocument(value: unknown): value is ConstraintsDocument {
  return (
    value !== null &&
    typeof value === 'object' &&
    'component' in value &&
    typeof (value as Record<string, unknown>)['component'] === 'string' &&
    'rules' in value &&
    Array.isArray((value as Record<string, unknown>)['rules'])
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type ValidationError = string;

function validateDocument(document: ConstraintsDocument, expectedId: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (document.component !== expectedId) {
    errors.push(
      `document.component "${document.component}" does not match expected id "${expectedId}"`,
    );
  }

  if (!KEBAB_CASE_PATTERN.test(document.component)) {
    errors.push(`document.component "${document.component}" is not kebab-case`);
  }

  if (!document.summary || document.summary.trim() === '') {
    errors.push('document.summary must be a non-empty string');
  }

  const seenRuleIds = new Set<string>();
  for (const rule of document.rules) {
    if (!rule.id || rule.id.trim() === '') {
      errors.push('every rule must have a non-empty id');
      continue;
    }

    if (!KEBAB_CASE_PATTERN.test(rule.id)) {
      errors.push(`rule id "${rule.id}" is not kebab-case`);
    }

    if (seenRuleIds.has(rule.id)) {
      errors.push(`duplicate rule id "${rule.id}" within document`);
    }
    seenRuleIds.add(rule.id);

    if (!VALID_SEVERITIES.has(rule.severity)) {
      errors.push(
        `rule "${rule.id}" has invalid severity "${rule.severity}"; must be one of: error, warning, info`,
      );
    }

    if (!rule.description || rule.description.trim() === '') {
      errors.push(`rule "${rule.id}" must have a non-empty description`);
    }

    if (!VALID_COMBINATORS.has(rule.kind)) {
      errors.push(
        `rule "${rule.id}" has invalid kind "${rule.kind}"; must be one of: exactlyOne, anyOf, allOf, requires`,
      );
    }

    if (!rule.of || rule.of.length === 0) {
      errors.push(`rule "${rule.id}" must have at least one predicate in "of"`);
    } else {
      if (rule.kind === 'requires' && rule.of.length !== 1) {
        errors.push(
          `rule "${rule.id}" uses "requires" kind but has ${rule.of.length} predicates in "of"; "requires" expects exactly one`,
        );
      }
      for (const [index, predicate] of rule.of.entries()) {
        const predicateError = validatePredicate(predicate, `rule "${rule.id}" of[${index}]`);
        if (predicateError) errors.push(predicateError);
      }
    }

    if (rule.when !== undefined) {
      const whenError = validatePredicate(rule.when, `rule "${rule.id}" when clause`);
      if (whenError) errors.push(whenError);
    }
  }

  return errors;
}

/**
 * Recursively validate the shape of a predicate. Returns the first error found
 * or `null` if the predicate is well-formed.
 *
 * Each predicate is exactly one of:
 *   { allOf: Predicate[] }
 *   { anyOf: Predicate[] }
 *   { snippet: string }
 *   { prop: string, equals: string | number | boolean }
 *   { prop: string, exists: true }
 *   { prop: string, nonEmpty: true }
 *
 * Any extra keys, missing keys, or mixed-shape combinations are rejected so
 * the evaluator never has to guess which discriminator wins.
 */
function validatePredicate(predicate: unknown, context: string): string | null {
  if (!isObjectRecord(predicate)) {
    return `${context}: predicate must be an object`;
  }
  const p = predicate;
  const keys = Object.keys(p);

  // Group-1 operators (each one is its own shape — no other discriminators allowed).
  const groupOperators = ['allOf', 'anyOf', 'snippet'] as const;
  const operatorsPresent = groupOperators.filter((k) => k in p);

  if (operatorsPresent.length > 1) {
    return `${context}: predicate has multiple top-level operators (${operatorsPresent.join(', ')}); each predicate must be exactly one shape`;
  }

  if (operatorsPresent.length === 1) {
    const op = operatorsPresent[0]!;
    // Operator-shape predicates do not share keys with prop-shape predicates.
    const otherKeys = keys.filter((k) => k !== op);
    if (otherKeys.length > 0) {
      return `${context}: "${op}" predicate has unexpected extra key(s): ${otherKeys.join(', ')}`;
    }
    if (op === 'allOf' || op === 'anyOf') {
      const children = p[op];
      if (!Array.isArray(children) || children.length === 0) {
        return `${context}: "${op}" must be a non-empty array`;
      }
      for (const [i, child] of children.entries()) {
        const err = validatePredicate(child, `${context} ${op}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    // snippet
    return typeof p['snippet'] === 'string' && p['snippet'].length > 0
      ? null
      : `${context}: "snippet" must be a non-empty string`;
  }

  // Prop-shape predicates require exactly one of equals/exists/nonEmpty plus a "prop" string.
  if (!('prop' in p) || typeof p['prop'] !== 'string' || p['prop'].length === 0) {
    return `${context}: predicate must include a non-empty "prop" string or one of allOf/anyOf/snippet`;
  }

  const propDiscriminators = ['equals', 'exists', 'nonEmpty'] as const;
  const presentDiscriminators = propDiscriminators.filter((k) => k in p);
  if (presentDiscriminators.length === 0) {
    return `${context}: predicate must include one of equals/exists/nonEmpty when "prop" is set`;
  }
  if (presentDiscriminators.length > 1) {
    return `${context}: predicate has multiple discriminators (${presentDiscriminators.join(', ')}); each predicate must use exactly one`;
  }

  // Reject any unexpected keys alongside `prop` + the chosen discriminator.
  const expectedKeys = new Set(['prop', presentDiscriminators[0]!]);
  const unexpected = keys.filter((k) => !expectedKeys.has(k));
  if (unexpected.length > 0) {
    return `${context}: predicate has unexpected extra key(s): ${unexpected.join(', ')}`;
  }

  // Per-discriminator value type checks.
  const disc = presentDiscriminators[0]!;
  if (disc === 'equals') {
    const v = p['equals'];
    if (typeof v === 'string' || typeof v === 'boolean') return null;
    if (typeof v === 'number') {
      // `NaN`, `Infinity`, and `-Infinity` round-trip as `null` through
      // `JSON.stringify`, breaking the serialized predicate. Reject them.
      if (!Number.isFinite(v)) {
        return `${context}: "equals" number must be finite (got ${v})`;
      }
      return null;
    }
    return `${context}: "equals" must be a string, number, or boolean`;
  }
  if (disc === 'exists') {
    return p['exists'] === true ? null : `${context}: "exists" must be \`true\``;
  }
  // nonEmpty
  return p['nonEmpty'] === true ? null : `${context}: "nonEmpty" must be \`true\``;
}

// ---------------------------------------------------------------------------
// Prop cross-check
// ---------------------------------------------------------------------------

/** Every prop and snippet name a predicate tree reads. */
export function predicateNames(predicate: Predicate): string[] {
  if ('allOf' in predicate) return predicate.allOf.flatMap(predicateNames);
  if ('anyOf' in predicate) return predicate.anyOf.flatMap(predicateNames);
  if ('snippet' in predicate) return [predicate.snippet];
  return [predicate.prop];
}

/**
 * The names a constraints document reads that the component does not have. `knownProps` holds
 * every prop of the component: its schema's `properties` and the `metadata.unsupportedProps` the
 * schema generator could not express (snippets, callbacks).
 */
export function findUnknownConstraintProps(
  document: ConstraintsDocument,
  knownProps: ReadonlySet<string>,
): string[] {
  const names = document.rules.flatMap((rule) => [
    ...rule.of.flatMap(predicateNames),
    ...(rule.when === undefined ? [] : predicateNames(rule.when)),
  ]);
  return [...new Set(names)].filter((name) => !knownProps.has(name)).toSorted();
}

/**
 * Every prop of a component: the properties of the `<Pascal>Props` type its `<name>.types.ts`
 * exports, with the HTML attributes it extends and the snippets it takes.
 */
export function componentPropNames(directory: string, name: string): Set<string> {
  const typesPath = join(directory, `${name}.types.ts`);
  const program = ts.createProgram([typesPath], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(typesPath);
  const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  const propsName = `${name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}Props`;
  const symbol = module
    ? checker.getExportsOfModule(module).find((entry) => entry.getName() === propsName)
    : undefined;
  if (symbol === undefined) return new Set();
  const type = checker.getDeclaredTypeOfSymbol(
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
  );
  const names = new Set<string>();
  const types = type.isUnion() ? type.types : [type];
  for (const member of types) {
    for (const property of checker.getPropertiesOfType(member)) names.add(property.getName());
  }
  return names;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/** One problem with a component's authored `<name>.constraints.json`. */
export type ConstraintIssue = { name: string; file: string; reason: string };

/** Check one authored constraints document against its shape rules and its component's props. */
export function checkConstraintsDocument(
  value: unknown,
  name: string,
  knownProps: ReadonlySet<string>,
): string[] {
  const schemaReference = isObjectRecord(value) ? value['$schema'] : undefined;
  if (!isConstraintsDocument(value)) {
    return ['must hold a constraints document with a component id and a rules array'];
  }
  const errors = validateDocument(value, name);
  if (errors.length > 0) return errors;
  if (schemaReference !== SCHEMA_REF) {
    errors.push(`$schema must be "${SCHEMA_REF}"`);
  }
  for (const prop of findUnknownConstraintProps(value, knownProps)) {
    errors.push(`names "${prop}", which is not a prop or snippet of ${name}`);
  }
  return errors;
}

/** Every problem with the authored constraints of the package's components; empty when none. */
export async function checkComponentConstraints(): Promise<ConstraintIssue[]> {
  const issues: ConstraintIssue[] = [];
  for (const component of await discoverComponentDirectories()) {
    const file = `${component.name}.constraints.json`;
    const path = join(component.directory, file);
    if (!existsSync(path)) continue;
    const knownProps = componentPropNames(component.directory, component.name);
    const value: unknown = await Bun.file(path).json();
    for (const reason of checkConstraintsDocument(value, component.name, knownProps)) {
      issues.push({ name: component.name, file, reason });
    }
  }
  return issues;
}

if (import.meta.main) {
  const issues = await checkComponentConstraints();
  if (issues.length === 0) {
    process.stdout.write('constraints:check — OK\n');
  } else {
    process.stderr.write('constraints:check — invalid authored constraints:\n');
    for (const issue of issues) {
      process.stderr.write(`  • ${issue.name}/${issue.file}: ${issue.reason}\n`);
    }
    process.exitCode = 1;
  }
}
