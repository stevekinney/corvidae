/**
 * API contract tests: validate every component's exported Props type against
 * the hand-maintained contract in src/api-contract.ts.
 *
 * Uses svelte/compiler.parse (AST-only) to inspect the Props type alias.
 * Checks: prop name presence, optionality match, type-kind match, snippet presence,
 * and generic constraint declarations.
 *
 * Test files may use `any` per project conventions.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parse } from 'svelte/compiler';

import type { ComponentContract, PropSpec, SnippetSpec } from './api-contract.ts';
import { CONTRACT } from './api-contract.ts';

const COMPONENTS_DIR = join(import.meta.dir, 'components');

function toPascal(kebab: string): string {
  return kebab
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

type ASTNode = any;

/**
 * The member's static name, or `undefined` when it has none. Identifier keys carry `name`;
 * quoted and numeric keys such as `'aria-label'` or `0` carry `value`. A computed key is
 * static only when it is a string or numeric literal (`['extra']`); `[dynamicKey]` has no name.
 */
function memberName(member: ASTNode): string | undefined {
  const key = member?.key;
  if (key?.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value);
  }
  if (!member?.computed && key?.type === 'Identifier') return key.name as string;
  return undefined;
}

/** `onSave(value: string): void` parses as a method signature, not a property signature. */
function isKeyedSignature(member: ASTNode): boolean {
  return (
    (member.type === 'TSPropertySignature' || member.type === 'TSMethodSignature') &&
    memberName(member) !== undefined
  );
}

function extractPropNames(typeLiteral: ASTNode): Set<string> {
  if (!typeLiteral || typeLiteral.type !== 'TSTypeLiteral') return new Set();
  return new Set(
    (typeLiteral.members ?? [])
      .filter(isKeyedSignature)
      .map((m: ASTNode) => memberName(m) as string),
  );
}

function isPropOptional(member: ASTNode): boolean {
  return Boolean(member?.optional);
}

function getMember(typeLiteral: ASTNode, name: string): ASTNode {
  if (!typeLiteral || typeLiteral.type !== 'TSTypeLiteral') return undefined;
  return (typeLiteral.members ?? []).find(
    (m: ASTNode) => isKeyedSignature(m) && memberName(m) === name,
  );
}

function getTypeKind(member: ASTNode): string | null {
  // A method signature's `typeAnnotation` is its return type; the member itself is a function.
  if (member?.type === 'TSMethodSignature') return 'TSFunctionType';
  return member?.typeAnnotation?.typeAnnotation?.type ?? null;
}

function findPropsTypeAlias(moduleBody: ASTNode[], propsName: string): ASTNode {
  for (const node of moduleBody) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    const decl = node.declaration;
    if (!decl) continue;
    if (decl.type === 'TSTypeAliasDeclaration' && decl.id?.name === propsName) {
      return decl.typeAnnotation;
    }
  }
  return undefined;
}

function unwrapTypeAnnotation(annotation: ASTNode): ASTNode {
  let current = annotation;
  while (current?.type === 'TSParenthesizedType') {
    current = current.typeAnnotation;
  }
  return current;
}

function resolvePropTypeLiteral(annotation: ASTNode): ASTNode {
  if (!annotation) return null;
  annotation = unwrapTypeAnnotation(annotation);
  if (annotation.type === 'TSTypeLiteral') {
    return { kind: 'literal', typeLiteral: annotation };
  }
  if (annotation.type === 'TSIntersectionType') {
    // `Base & { a } & { b }`: every top-level inline literal contributes members, so the
    // arm is checked as one literal that holds all of them.
    const literals = (annotation.types ?? [])
      .map((t: ASTNode) => unwrapTypeAnnotation(t))
      .filter((t: ASTNode) => t.type === 'TSTypeLiteral');
    const merged =
      literals.length === 0
        ? null
        : { type: 'TSTypeLiteral', members: literals.flatMap((l: ASTNode) => l.members ?? []) };
    return { kind: 'intersection', typeLiteral: merged };
  }
  if (annotation.type === 'TSUnionType') {
    const arms = (annotation.types ?? [])
      .map((arm: ASTNode) => {
        const unwrappedArm = unwrapTypeAnnotation(arm);
        const r = resolvePropTypeLiteral(unwrappedArm);
        if (r?.kind !== 'union' && r !== null) return r;
        // TSTypeReference arm (named type alias) — can't resolve without ts-morph.
        // Return a placeholder so arity check still works.
        if (unwrappedArm.type === 'TSTypeReference')
          return { kind: 'literal', typeLiteral: null, unresolvable: true };
        return null;
      })
      .filter(Boolean);
    return { kind: 'union', arms };
  }
  return null;
}

function validateArm(
  file: string,
  armIndex: number | null,
  typeLiteral: ASTNode,
  contractProps: Record<string, PropSpec>,
  contractSnippets: Record<string, SnippetSpec>,
  errors: string[],
) {
  const prefix = armIndex !== null ? ` arm[${armIndex}]` : '';
  const label = (msg: string) => `${file}${prefix}: ${msg}`;

  const actualProps = extractPropNames(typeLiteral);

  for (const propName of Object.keys(contractProps)) {
    if (propName === 'class') continue; // renamed to className in destructuring — skip
    if (!actualProps.has(propName)) {
      errors.push(label(`prop "${propName}" expected but not found in Props`));
      continue;
    }

    const member = getMember(typeLiteral, propName);
    const contractProp = contractProps[propName] as PropSpec;

    if (isPropOptional(member) !== contractProp.optional) {
      const expected = contractProp.optional ? 'optional' : 'required';
      const got = isPropOptional(member) ? 'optional' : 'required';
      errors.push(label(`prop "${propName}" is ${got} but contract says ${expected}`));
    }

    const kind = getTypeKind(member);
    if (kind && kind !== contractProp.type_kind) {
      errors.push(
        label(
          `prop "${propName}" type kind is "${kind}", contract says "${contractProp.type_kind}"`,
        ),
      );
    }
  }

  for (const actualName of actualProps) {
    if (!Object.hasOwn(contractProps, actualName) && !Object.hasOwn(contractSnippets, actualName)) {
      errors.push(label(`prop "${actualName}" is in Props but not listed in the contract`));
    }
  }

  for (const snippetName of Object.keys(contractSnippets)) {
    const spec = contractSnippets[snippetName] as SnippetSpec;
    if (!actualProps.has(snippetName) && !spec.optional) {
      errors.push(label(`required snippet "${snippetName}" not found in Props`));
    }
  }
}

function validateContract(
  file: string,
  resolved: ASTNode,
  contract: ComponentContract,
  errors: string[],
) {
  if (!resolved) {
    errors.push(`${file}: could not resolve Props type from AST`);
    return;
  }

  if (contract.kind === 'union') {
    if (resolved.kind !== 'union') {
      errors.push(
        `${file}: contract expects union (Shape C) but Props is ${resolved.kind as string}`,
      );
      return;
    }
    const contractArms = contract.arms ?? [];
    if ((resolved.arms as ASTNode[]).length !== contractArms.length) {
      errors.push(
        `${file}: Props union has ${(resolved.arms as ASTNode[]).length} arms, contract expects ${contractArms.length}`,
      );
      return;
    }
    for (let i = 0; i < contractArms.length; i++) {
      const arm = (resolved.arms as ASTNode[])[i];
      // Skip per-arm validation when the arm is a TSTypeReference (named alias) that
      // can't be resolved to a TSTypeLiteral without ts-morph. Phase 4 will cover this.
      if (arm.unresolvable) continue;
      const contractArm = contractArms[i]!;
      validateArm(file, i, arm.typeLiteral, contractArm.props, contractArm.snippets, errors);
    }
    return;
  }

  if (contract.kind === 'literal' || contract.kind === 'intersection') {
    if (resolved.kind === 'union') {
      errors.push(`${file}: Props is a union but contract expects ${contract.kind}`);
      return;
    }
    const props = contract.props ?? {};
    const snippets = contract.snippets ?? {};
    validateArm(file, null, resolved.typeLiteral, props, snippets, errors);
  }
}

/** Parses an inline Props type the way the component test parses `<script module>`. */
function parseFixtureProps(typeSource: string): ASTNode {
  const wrapped = `<script module lang="ts">\nexport type FixtureProps = ${typeSource};\n</script>`;
  const ast = parse(wrapped, { filename: 'fixture.svelte', modern: true });
  const annotation = findPropsTypeAlias(ast.module?.content?.body as ASTNode[], 'FixtureProps');
  return resolvePropTypeLiteral(annotation);
}

describe('validateArm unlisted members', () => {
  test('reports a Props member the contract does not list', () => {
    const resolved = parseFixtureProps('{ listed?: string; extra?: string }');
    const errors: string[] = [];
    validateArm(
      'fixture.svelte',
      null,
      resolved.typeLiteral,
      { listed: { optional: true, type_kind: 'TSStringKeyword', default: undefined } },
      {},
      errors,
    );
    expect(errors).toEqual([
      'fixture.svelte: prop "extra" is in Props but not listed in the contract',
    ]);
  });

  test('accepts a Props member listed under snippets', () => {
    const resolved = parseFixtureProps('{ listed?: string; children?: Snippet }');
    const errors: string[] = [];
    validateArm(
      'fixture.svelte',
      null,
      resolved.typeLiteral,
      { listed: { optional: true, type_kind: 'TSStringKeyword', default: undefined } },
      { children: { kind: 'zero-arg', optional: true } },
      errors,
    );
    expect(errors).toEqual([]);
  });

  test('prefixes an unlisted member in the second arm with arm[1]', () => {
    const resolved = parseFixtureProps('{ a?: string } | { b?: string; extra?: string }');
    const errors: string[] = [];
    resolved.arms.forEach((arm: ASTNode, index: number) => {
      const name = index === 0 ? 'a' : 'b';
      validateArm(
        'fixture.svelte',
        index,
        arm.typeLiteral,
        { [name]: { optional: true, type_kind: 'TSStringKeyword', default: undefined } },
        {},
        errors,
      );
    });
    expect(errors).toEqual([
      'fixture.svelte arm[1]: prop "extra" is in Props but not listed in the contract',
    ]);
  });

  test('reports an unlisted method-signature member and accepts a listed one', () => {
    const resolved = parseFixtureProps(
      '{ listed?: string; onSave(value: string): void; onClose?(): void }',
    );
    const errors: string[] = [];
    validateArm(
      'fixture.svelte',
      null,
      resolved.typeLiteral,
      {
        listed: { optional: true, type_kind: 'TSStringKeyword', default: undefined },
        onClose: { optional: true, type_kind: 'TSFunctionType', default: undefined },
      },
      {},
      errors,
    );
    expect(errors).toEqual([
      'fixture.svelte: prop "onSave" is in Props but not listed in the contract',
    ]);
  });

  test('checks every inline literal of an intersection', () => {
    const resolved = parseFixtureProps('Base & { a?: string } & { b?: string }');
    const errors: string[] = [];
    validateArm(
      'fixture.svelte',
      null,
      resolved.typeLiteral,
      { a: { optional: true, type_kind: 'TSStringKeyword', default: undefined } },
      {},
      errors,
    );
    expect(errors).toEqual(['fixture.svelte: prop "b" is in Props but not listed in the contract']);
  });

  test('checks statically named computed keys and ignores dynamic ones', () => {
    const resolved = parseFixtureProps(
      "{ listed?: string; ['extra']?: string; [0]?: string; [dynamicKey]?: string }",
    );
    const errors: string[] = [];
    validateArm(
      'fixture.svelte',
      null,
      resolved.typeLiteral,
      { listed: { optional: true, type_kind: 'TSStringKeyword', default: undefined } },
      {},
      errors,
    );
    expect(errors).toEqual([
      'fixture.svelte: prop "extra" is in Props but not listed in the contract',
      'fixture.svelte: prop "0" is in Props but not listed in the contract',
    ]);
  });
});

describe('api contract', () => {
  test('every component Props matches the frozen contract', async () => {
    const errors: string[] = [];

    for (const [name, contract] of Object.entries(CONTRACT)) {
      const file = `${name}.svelte`;
      // Migrated components live at src/components/<name>/<name>.svelte; legacy
      // flat components live at src/components/<name>.svelte. Try the directory
      // shape first so the test transparently spans both layouts during the
      // partial-migration window.
      const directoryPath = join(COMPONENTS_DIR, name, file);
      const flatPath = join(COMPONENTS_DIR, file);

      let source: string;
      try {
        source = await readFile(directoryPath, 'utf-8');
      } catch {
        try {
          source = await readFile(flatPath, 'utf-8');
        } catch {
          errors.push(`${file}: not found in src/components/`);
          continue;
        }
      }

      let ast: ReturnType<typeof parse>;
      try {
        ast = parse(source, { filename: file, modern: true });
      } catch (err) {
        errors.push(`${file}: parse error — ${String(err)}`);
        continue;
      }

      let moduleBody = ast['module']?.content?.body as ASTNode[] | undefined;
      if (!moduleBody) {
        errors.push(`${file}: missing module script`);
        continue;
      }

      const pascal = toPascal(name);
      let propsAnnotation = findPropsTypeAlias(moduleBody, `${pascal}Props`);

      // After migration, types live in <name>.types.ts and the .svelte module
      // script only re-exports them. Fall back to parsing the types file via a
      // synthetic <script module> wrapper so the same AST walker keeps working.
      if (!propsAnnotation) {
        const typesPath = join(COMPONENTS_DIR, name, `${name}.types.ts`);
        try {
          const typesSource = await readFile(typesPath, 'utf-8');
          const wrapped = `<script module lang="ts">\n${typesSource}\n</script>`;
          const typesAst = parse(wrapped, { filename: `${name}.types.ts`, modern: true });
          const typesBody = typesAst.module?.content?.body as ASTNode[] | undefined;
          if (typesBody) {
            moduleBody = typesBody;
            propsAnnotation = findPropsTypeAlias(typesBody, `${pascal}Props`);
          }
        } catch {
          // No types.ts — leave propsAnnotation as undefined, error below.
        }
      }

      if (!propsAnnotation) {
        errors.push(
          `${file}: could not find export type ${pascal}Props in module script or types.ts`,
        );
        continue;
      }

      const resolved = resolvePropTypeLiteral(propsAnnotation);
      validateContract(file, resolved, contract, errors);

      // Generic constraint check.
      // Svelte 5 surfaces the generics attribute on the instance script's attributes array,
      // not on the parsed content body. Find it via ast.instance.attributes.
      if (contract.generics && contract.generics.length > 0) {
        const instanceAttrs: ASTNode[] = ast['instance']?.attributes ?? [];
        const genericsAttrNode = instanceAttrs.find((a: ASTNode) => a.name === 'generics');
        const genericsAttr = (genericsAttrNode?.value?.[0]?.data as string | undefined) ?? '';
        for (const gen of contract.generics) {
          if (!genericsAttr.includes(gen.name)) {
            errors.push(`${file}: expected generic "${gen.name}" in <script generics="...">`);
          }
          if (gen.constraint && !genericsAttr.includes(gen.constraint)) {
            errors.push(`${file}: generic "${gen.name}" must have constraint "${gen.constraint}"`);
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`API contract violations:\n${errors.map((e) => `  • ${e}`).join('\n')}`);
    }
    // This test compiles/inspects every component's Props against the frozen
    // contract — inherently slow and prone to exceeding the 5s default under
    // CPU contention (e.g. parallel CI / multi-worktree). Generous timeout.
  }, 60_000);
});
