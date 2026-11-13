import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

/** Types whose names carry a role suffix and so must be listed here, by name; the list only shrinks. */
const EXEMPT_TYPES: ReadonlySet<string> = new Set([
  'PluginAgentListing',
  'PluginGoalRequest',
  'PluginScheduleDefinition',
  'PluginSetupContext',
  'PluginSetupResult',
  'PluginSecretDeclaration',
  'PluginTriggerContext',
  'PluginTriggerOutcome',
  'PluginReactionContext',
  'PluginReactionError',
  'PluginFormatting',
  'PluginScore',
  'PluginEventDeclaration',
  'PluginTriggerListing',
  'PluginReactionListing',
]);

/** The last word that marks an exported type as supporting a contribution rather than being one. */
const ROLE_SUFFIX =
  /(Context|Outcome|Listing|Declaration|Request|Definition|Error|Formatting|Score|Result)$/;

/** Members that are not yet one lowercase word, each awaiting the issue that removes it. None now. */
const PENDING_MEMBERS: ReadonlySet<string> = new Set();

/** The types whose members are plugin-facing. */
const MEMBER_TYPES = [
  'PluginDescriptor',
  'PluginSetupContext',
  'PluginSetupResult',
  'PluginContributions',
  'PluginHost',
];

/** The nested group whose members are the guardrail families, not walked. */
const NESTED_EXCEPTION = 'guardrails';

/** Compiles the package's own entry module. */
function packageProgram(): { program: ts.Program; entry: string } {
  const root = resolve(import.meta.dir, '../..');
  const entry = resolve(root, 'src/index.ts');
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  return { program: ts.createProgram([entry], { ...parsed.options, noEmit: true }), entry };
}

/** Compiles in-memory sources as one program whose entry is `index.ts`. */
function fixtureProgram(files: Record<string, string>): { program: ts.Program; entry: string } {
  const options: ts.CompilerOptions = { noEmit: true, strict: true, types: [] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.fileExists = (path) => path in files || ts.sys.fileExists(path);
  host.getSourceFile = (path, languageVersion) =>
    path in files
      ? ts.createSourceFile(path, files[path] ?? '', languageVersion)
      : original(path, languageVersion);
  return { program: ts.createProgram(['index.ts'], options, host), entry: 'index.ts' };
}

/** The exported symbols of a module, by name. */
function exportsOf(program: ts.Program, entry: string): Map<string, ts.Symbol> {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`${entry} is not a module`);
  return new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));
}

/** The singular of a contribution key: `activities` is `activity`, `tools` is `tool`. */
function singular(word: string): string {
  return word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.replace(/s$/, '');
}

/** The name an exported type carries, when it has one. */
function typeName(type: ts.Type): string | undefined {
  return type.aliasSymbol?.name ?? type.getSymbol()?.name;
}

/**
 * Walks the members of each named type, and of each anonymous object type nested in one, collecting
 * a failure for every member that is not one lowercase word or ends in `Kind` or `Kinds`.
 */
function memberFailures(program: ts.Program, entry: string, names: readonly string[]): string[] {
  const checker = program.getTypeChecker();
  const exported = exportsOf(program, entry);
  const failures: string[] = [];

  const walk = (type: ts.Type, path: string, location: ts.Node): void => {
    for (const property of checker.getPropertiesOfType(type)) {
      const member = `${path}.${property.name}`;
      if (!PENDING_MEMBERS.has(property.name)) {
        if (!/^[a-z]+$/.test(property.name)) failures.push(`${member} is not one lowercase word`);
        if (/Kinds?$/.test(property.name)) failures.push(`${member} ends in Kind or Kinds`);
      }
      if (property.name === NESTED_EXCEPTION) continue;
      const nested = checker.getNonNullableType(
        checker.getTypeOfSymbolAtLocation(property, location),
      );
      if (nested.aliasSymbol === undefined && nested.getSymbol()?.getName() === '__type') {
        walk(nested, member, location);
      }
    }
  };

  for (const name of names) {
    const symbol = exported.get(name);
    const location = symbol?.declarations?.[0];
    if (symbol === undefined || location === undefined) {
      failures.push(`${name} is not exported`);
      continue;
    }
    walk(checker.getDeclaredTypeOfSymbol(symbol), name, location);
  }
  return failures;
}

/** Failures for the exported contribution types and the role-suffixed supporting types. */
function typeFailures(program: ts.Program, entry: string): string[] {
  const checker = program.getTypeChecker();
  const exported = exportsOf(program, entry);
  const failures: string[] = [];

  for (const name of exported.keys()) {
    if (!name.startsWith('Plugin')) continue;
    if (/Kinds?$/.test(name)) failures.push(`${name} ends in Kind or Kinds`);
    if (ROLE_SUFFIX.test(name) && !EXEMPT_TYPES.has(name)) {
      failures.push(`${name} carries a role suffix and is not on the exempt list`);
    }
  }

  const contributions = exported.get('PluginContributions');
  const location = contributions?.declarations?.[0];
  if (contributions === undefined || location === undefined) {
    return [...failures, 'PluginContributions is not exported'];
  }
  const declared = checker.getDeclaredTypeOfSymbol(contributions);
  for (const property of checker.getPropertiesOfType(declared)) {
    if (property.name === NESTED_EXCEPTION || PENDING_MEMBERS.has(property.name)) continue;
    const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, location));
    const element = checker.isArrayType(type)
      ? checker.getTypeArguments(type as ts.TypeReference)[0]
      : type;
    const found = element && typeName(element);
    // A contribution built from another package's type (a tool, a validator) keeps that name.
    if (found === undefined || !found.startsWith('Plugin')) continue;
    const expected = `Plugin${singular(property.name).replace(/^./, (letter) => letter.toUpperCase())}`;
    if (found !== expected) failures.push(`${property.name} is ${found}, not ${expected}`);
  }
  return failures;
}

describe('plugin naming taxonomy', () => {
  const { program, entry } = packageProgram();

  test('every plugin-facing member is one lowercase word', () => {
    expect(memberFailures(program, entry, MEMBER_TYPES)).toEqual([]);
  });

  test('every exported contribution and supporting type follows the taxonomy', () => {
    expect(typeFailures(program, entry)).toEqual([]);
  });

  test('a contribution key fooBar fails', () => {
    const fixture = fixtureProgram({
      'index.ts': 'export interface PluginContributions { readonly fooBar?: readonly string[] }',
    });
    expect(memberFailures(fixture.program, fixture.entry, ['PluginContributions'])).toEqual([
      'PluginContributions.fooBar is not one lowercase word',
    ]);
  });

  test('a PluginFooBarContext type that is not on the list fails', () => {
    const fixture = fixtureProgram({
      'index.ts': `export interface PluginFooBarContext { readonly x: 1 }
export interface PluginContributions {}`,
    });
    expect(typeFailures(fixture.program, fixture.entry)).toEqual([
      'PluginFooBarContext carries a role suffix and is not on the exempt list',
    ]);
  });

  test('a contribution type that is not Plugin plus the singular noun fails', () => {
    const fixture = fixtureProgram({
      'index.ts': `export interface PluginWidgetThing { readonly name: string }
export interface PluginContributions { readonly widgets?: readonly PluginWidgetThing[] }`,
    });
    expect(typeFailures(fixture.program, fixture.entry)).toEqual([
      'widgets is PluginWidgetThing, not PluginWidget',
    ]);
  });

  test('a Kind or Kinds suffix on a member fails', () => {
    const fixture = fixtureProgram({
      'index.ts':
        'export interface PluginHost { readonly routerkinds: string; readonly fooKind: 1 }',
    });
    expect(memberFailures(fixture.program, fixture.entry, ['PluginHost'])).toEqual([
      'PluginHost.fooKind is not one lowercase word',
      'PluginHost.fooKind ends in Kind or Kinds',
    ]);
  });
});
