/**
 * Generates flattened, non-generic copies of the `svelte/elements` attribute
 * interfaces this package forwards from more than one arm of a discriminated
 * Props union.
 *
 * ## Why this exists (COR-239)
 *
 * `svelte/elements`'s `HTMLAttributes<T>`, `HTMLButtonAttributes`, and
 * `HTMLAnchorAttributes` are a multi-level interface inheritance chain
 * parameterized by a generic element type (`HTMLAttributes<T> extends
 * AriaAttributes, DOMAttributes<T>`). Referencing one of them — directly, via
 * `Omit`, or via `Pick<T, keyof T>` — from two or more arms of an exported
 * discriminated union makes `keyof` of that union expensive: Svelte's
 * `Component<Props, Exports, Bindings extends keyof Props | ''>` computes
 * `keyof Props` to check its `Bindings` constraint, and doing that once per
 * union arm re-walks the generic inheritance chain once per arm. One arm is
 * cheap; two or more exceeds TypeScript's type complexity budget, and a
 * downstream consumer sees `TS2590: Expression produces a union type that is
 * too complex to represent` under `skipLibCheck: false` — exactly what a real
 * install of a published Cinder version hits (see
 * `scripts/consumer-strict-types.test.ts`).
 *
 * A flattened copy — every property's already-resolved type, listed on a
 * plain object type with no generic parameter and no `extends` clause —
 * makes `keyof` trivial: there is no chain left to walk. This script
 * produces those copies mechanically from the real `svelte/elements`
 * declarations, so nobody hand-transcribes ~445 properties and nobody has to
 * verify by hand that the copy stays identical to what `svelte/elements`
 * actually declares whenever svelte is upgraded — `attributes:check` (part
 * of the default `bun test` suite) fails the moment it drifts.
 */

import { join } from 'node:path';
import ts from 'typescript';

export class ForwardedAttributesError extends Error {}

interface AttributeTarget {
  /** Exported name of the flattened type this script writes. */
  readonly exportName: string;
  /** A type expression, valid inside the probe file, naming the source type. */
  readonly expression: string;
}

/**
 * Every svelte/elements interface this package references from two or more
 * arms of an exported Props union. Add an entry here — and switch the
 * relevant `.types.ts` file over to the flattened export — whenever a new
 * component's discriminated union needs to forward one of these.
 */
const TARGETS: readonly AttributeTarget[] = [
  { exportName: 'FlatHTMLButtonAttributes', expression: 'HTMLButtonAttributes' },
  { exportName: 'FlatHTMLAnchorAttributes', expression: 'HTMLAnchorAttributes' },
  { exportName: 'FlatHTMLAttributesElement', expression: 'HTMLAttributes<HTMLElement>' },
  { exportName: 'FlatHTMLAttributesDivElement', expression: 'HTMLAttributes<HTMLDivElement>' },
  { exportName: 'FlatHTMLAttributesSpanElement', expression: 'HTMLAttributes<HTMLSpanElement>' },
];

const PACKAGE_ROOT = join(import.meta.dir, '..');
export const GENERATED_FILE_PATH = join(
  PACKAGE_ROOT,
  'src/_internal/forwarded-html-attributes.generated.ts',
);

const GENERATED_HEADER = `/**
 * GENERATED FILE — do not hand-edit.
 *
 * Run \`bun run --filter=@lostgradient/cinder attributes:generate\` to refresh
 * after a svelte upgrade. \`attributes:check\` — part of the default \`bun
 * test\` suite via \`scripts/generate-forwarded-html-attributes.test.ts\` —
 * fails if this drifts from what \`svelte/elements\` currently declares.
 *
 * See the module doc on \`scripts/generate-forwarded-html-attributes.ts\` for
 * why this file exists (COR-239): every type below is a flattened,
 * non-generic copy of a \`svelte/elements\` interface, kept byte-for-byte
 * equivalent to the original so components can forward it from more than one
 * arm of a discriminated union without tripping TS2590.
 */

`;

function quotePropertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** A throwaway in-memory program used only to resolve types; nothing here is written to disk. */
function createProbeProgram(probeFileName: string, probeContent: string): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    customConditions: ['browser', 'svelte'],
    allowImportingTsExtensions: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, ...rest) => {
    if (fileName === probeFileName) {
      return ts.createSourceFile(
        fileName,
        probeContent,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS,
      );
    }
    return originalGetSourceFile(fileName, languageVersionOrOptions, ...rest);
  };
  host.fileExists = (fileName) => fileName === probeFileName || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    fileName === probeFileName ? probeContent : ts.sys.readFile(fileName);
  return ts.createProgram({ rootNames: [probeFileName], options: compilerOptions, host });
}

/**
 * The full set of names `svelte/elements` exports, so the generated file
 * imports exactly the helper types (`EventHandler`, `Booleanish`, `AriaRole`,
 * the per-category `*EventHandler` aliases, …) that its flattened property
 * types actually reference — never a hand-maintained list that could drift.
 */
function exportedElementsNames(program: ts.Program, checker: ts.TypeChecker): ReadonlySet<string> {
  const elementsSourceFile = program
    .getSourceFiles()
    .find((file) => file.fileName.endsWith('/svelte/elements.d.ts'));
  if (!elementsSourceFile) {
    throw new ForwardedAttributesError(
      "Could not locate svelte's elements.d.ts among the probe program's source files.",
    );
  }
  const moduleSymbol = checker.getSymbolAtLocation(elementsSourceFile);
  if (!moduleSymbol) {
    throw new ForwardedAttributesError('Could not resolve svelte/elements as a module symbol.');
  }
  return new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name));
}

interface FlattenedTarget extends AttributeTarget {
  readonly propertyLines: readonly string[];
  readonly indexSignatureLines: readonly string[];
}

/** Build the flattened property list for every configured target in one probe program. */
function flattenTargets(): { targets: readonly FlattenedTarget[]; usedNames: ReadonlySet<string> } {
  const probeFileName = join(PACKAGE_ROOT, '__forwarded-html-attributes-probe__.ts');
  const probeContent =
    `import type { HTMLAttributes, HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';\n` +
    TARGETS.map((target, index) => `export type __Probe${index} = ${target.expression};\n`).join(
      '',
    );

  const program = createProbeProgram(probeFileName, probeContent);
  const checker = program.getTypeChecker();
  const probeSourceFile = program.getSourceFile(probeFileName);
  if (!probeSourceFile) {
    throw new ForwardedAttributesError('The probe source file did not load into the program.');
  }

  const preEmitDiagnostics = ts.getPreEmitDiagnostics(program, probeSourceFile);
  if (preEmitDiagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(preEmitDiagnostics, {
      getCurrentDirectory: () => PACKAGE_ROOT,
      getCanonicalFileName: (fileName) => fileName,
      getNewLine: () => '\n',
    });
    throw new ForwardedAttributesError(
      `The probe file used to resolve svelte/elements types failed to type-check:\n${formatted}`,
    );
  }

  const usedNames = new Set<string>();
  const flattened: FlattenedTarget[] = [];

  ts.forEachChild(probeSourceFile, (node) => {
    if (!ts.isTypeAliasDeclaration(node)) return;
    const index = TARGETS.findIndex((_, targetIndex) => node.name.text === `__Probe${targetIndex}`);
    if (index === -1) return;
    const target = TARGETS[index];
    if (!target) return;
    const type = checker.getTypeAtLocation(node.name);
    const properties = checker.getPropertiesOfType(type);
    const propertyLines = properties.map((property) => {
      // `getTypeOfSymbolAtLocation` returns the WIDENED "read" type for an optional property —
      // it silently unions in `undefined` even when the declaration's own value type doesn't say
      // so (svelte/elements declares `children?: Snippet`, no `| undefined`). Printing that
      // widened type made every optional property here `| undefined` whether or not the source
      // said so, which under this workspace's `exactOptionalPropertyTypes: true` is a genuinely
      // different (and incompatible) type from what svelte/elements actually declares — it broke
      // spreading a flattened type's properties onto a real element while diagnosing COR-239.
      // `getTypeOfSymbolAtLocation` is still what performs generic substitution correctly (`T` in
      // `DOMAttributes<T>` resolves to e.g. `HTMLButtonElement`), so it stays the source of truth;
      // an `undefined` member is dropped only when the property's own declaration syntax doesn't
      // write one explicitly (some, like `disabled?: boolean | null | undefined`, do — those are
      // left untouched).
      const declaration = property.declarations?.find(
        (candidate): candidate is ts.PropertySignature => ts.isPropertySignature(candidate),
      );
      const declaresUndefinedExplicitly =
        declaration?.type !== undefined &&
        ts.isUnionTypeNode(declaration.type) &&
        declaration.type.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword);
      const widenedType = checker.getTypeOfSymbolAtLocation(property, node.name);
      const isOptional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      const format = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;
      // `TypeChecker` has no public API to rebuild a `Type` object from a filtered member list
      // (`getUnionType`/`UnionReduction` are compiler-internal, not part of the public typescript
      // module), so the auto-added `undefined` is dropped at the TEXT level: print every
      // remaining member and join them, rather than the widened type as a whole. This module
      // only ever needs printed text, never a `Type` object to feed back into further checks.
      const printed =
        isOptional && !declaresUndefinedExplicitly && widenedType.isUnion()
          ? widenedType.types
              .filter((member) => (member.flags & ts.TypeFlags.Undefined) === 0)
              .map((member) => checker.typeToString(member, node.name, format))
              .join(' | ')
          : checker.typeToString(widenedType, node.name, format);
      for (const word of printed.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) usedNames.add(word[0]);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
      return `  ${quotePropertyName(property.name)}${optional}: ${printed};`;
    });
    // Named properties alone drop index signatures — `HTMLAttributes<T>` carries
    // `[key: \`data-${string}\`]: any` and `[key: symbol]: Attachment<T> | ...`, and a consumer
    // (or one of this workspace's own `.svelte` files, e.g. menu-bar's `data-cinder-menu-bar-
    // submenu-trigger`) relies on both. `getPropertiesOfType` only returns named members, so
    // index signatures are captured separately here.
    const indexSignatureLines = checker.getIndexInfosOfType(type).map((indexInfo) => {
      const keyType = checker.typeToString(
        indexInfo.keyType,
        node.name,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
      );
      const valueType = checker.typeToString(
        indexInfo.type,
        node.name,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
      );
      for (const word of `${keyType} ${valueType}`.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
        usedNames.add(word[0]);
      }
      return `  [key: ${keyType}]: ${valueType};`;
    });
    flattened.push({ ...target, propertyLines, indexSignatureLines });
  });

  if (flattened.length !== TARGETS.length) {
    throw new ForwardedAttributesError(
      `Expected to resolve ${TARGETS.length} probe type(s) but found ${flattened.length}. ` +
        'Did a target expression stop type-checking as a standalone type alias?',
    );
  }

  return { targets: flattened, usedNames };
}

/** Render the generated module's source text (unformatted; the caller runs it through prettier). */
export function renderForwardedHtmlAttributesModule(): string {
  const { targets, usedNames } = flattenTargets();
  const program = createProbeProgram(
    join(PACKAGE_ROOT, '__unused-probe__.ts'),
    `import type { HTMLAttributes, HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';\nexport type __Unused = HTMLAttributes<HTMLElement> | HTMLAnchorAttributes | HTMLButtonAttributes;\n`,
  );
  const checker = program.getTypeChecker();
  const elementsExports = exportedElementsNames(program, checker);
  const ownExportNames = new Set(TARGETS.map((target) => target.exportName));
  const neededImports = [...usedNames]
    .filter((name) => elementsExports.has(name) && !ownExportNames.has(name))
    .toSorted();

  const importLine =
    neededImports.length > 0
      ? `import type { ${neededImports.join(', ')} } from 'svelte/elements';\n\n`
      : '';

  // Named properties and index signatures are rendered as two separate exported types, not one.
  // A flattened type carrying ~445 named properties is already right at TypeScript's type
  // complexity budget when referenced from two or more union arms (that budget is the entire
  // reason this generator exists); adding `HTMLAttributes<T>`'s `[key: \`data-${string}\`]: any`
  // and `[key: symbol]: Attachment<T> | ...` index signatures to the SAME type tips it back over.
  // Kept separate and small, the index-signature type is cheap to reference from just as many
  // arms (verified empirically while diagnosing COR-239) — see each `*.types.ts` consumer, which
  // intersects both types in the same position.
  const body = targets
    .flatMap((target) => [
      `export type ${target.exportName} = {\n${target.propertyLines.join('\n')}\n};\n`,
      target.indexSignatureLines.length > 0
        ? `export type ${target.exportName}IndexSignatures = {\n${target.indexSignatureLines.join('\n')}\n};\n`
        : null,
    ])
    .filter((entry) => entry !== null)
    .join('\n');

  return `${GENERATED_HEADER}${importLine}${body}`;
}

export async function generateForwardedHtmlAttributesModule(): Promise<string> {
  // Dynamic import, matching `generate-component-artifacts.ts`'s own CLI-entrypoint-vs-heavier-
  // dependencies split: a static import of `component-artifact-operations.ts` (which imports
  // `prettier`) resolves `prettier` against this package's `svelte`/`browser` test conditions
  // and gets its browser bundle, which has no `resolveConfig`; a dynamic import resolves at
  // plain Node/Bun runtime and gets the real one.
  const { formatGenerated } = await import('./component-artifact-operations.ts');
  return formatGenerated(renderForwardedHtmlAttributesModule(), GENERATED_FILE_PATH);
}

export async function checkForwardedHtmlAttributesModule(): Promise<string[]> {
  const generated = await generateForwardedHtmlAttributesModule();
  const file = Bun.file(GENERATED_FILE_PATH);
  if (!(await file.exists())) {
    return [`${GENERATED_FILE_PATH} does not exist. Run attributes:generate.`];
  }
  const committed = await file.text();
  return committed === generated
    ? []
    : [`${GENERATED_FILE_PATH} is stale. Run attributes:generate to refresh it.`];
}

async function main(): Promise<number> {
  const checkOnly = Bun.argv.includes('--check');
  if (checkOnly) {
    const issues = await checkForwardedHtmlAttributesModule();
    for (const issue of issues) process.stderr.write(`attributes:check — ${issue}\n`);
    return issues.length === 0 ? 0 : 1;
  }
  const generated = await generateForwardedHtmlAttributesModule();
  await Bun.write(GENERATED_FILE_PATH, generated);
  process.stdout.write(`Wrote ${GENERATED_FILE_PATH}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main());
