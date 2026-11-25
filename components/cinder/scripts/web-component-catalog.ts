import { basename, join } from 'node:path';
import ts from 'typescript';
import type { ComponentSchemaOutput } from '../../../internal/component-tooling/scripts/generate-component-schema.ts';

export type PropertyOptions = {
  type?: 'Array' | 'Boolean' | 'Number' | 'Object';
  attribute?: string;
  source?: string;
  renderer?: boolean;
};

type CatalogComponent = {
  id: string;
  name: string;
  artifacts: { schema: string };
};

// The schema omits inherited HTML attributes. These browser controls must
// forward the native form contract to the control rendered inside the host.
const formAttributes = new Map<string, PropertyOptions['type']>([
  ['name', undefined],
  ['type', undefined],
  ['form', undefined],
  ['disabled', 'Boolean'],
  ['required', 'Boolean'],
  ['readonly', 'Boolean'],
  ['multiple', 'Boolean'],
  ['minlength', 'Number'],
  ['maxlength', 'Number'],
  ['pattern', undefined],
  ['min', undefined],
  ['max', undefined],
  ['step', undefined],
  ['value', undefined],
]);

function attributeType(
  schema: ComponentSchemaOutput['properties'][string],
): PropertyOptions['type'] {
  if (schema.type === 'integer' || schema.type === 'number') return 'Number';
  if (schema.type === 'boolean') return 'Boolean';
  if (schema.type === 'array') return 'Array';
  if (schema.type === 'object') return 'Object';
  const values = (schema.enum ?? [schema.const]).filter((value) => value != null);
  if (values.length > 0 && values.every((value) => typeof value === 'number')) return 'Number';
  if (values.length > 0 && values.every((value) => typeof value === 'boolean')) return 'Boolean';
  const variants = schema.anyOf?.filter((variant) => variant.type !== 'null').map(attributeType);
  const first = variants?.[0];
  return first !== undefined && variants?.every((variant) => variant === first) ? first : undefined;
}

function hasSnippet(type: ts.Type): boolean {
  return type.isUnionOrIntersection()
    ? type.types.some(hasSnippet)
    : type.getSymbol()?.getName() === 'Snippet';
}

function kebabCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function prefixed(prefix: string, value: string) {
  return prefix + value.charAt(0).toUpperCase() + value.slice(1);
}

/** Derive the browser properties from the catalog, JSON schemas, and source prop declarations. */
export async function readWebComponentCatalog(root: string) {
  const manifest: { components: CatalogComponent[] } = await Bun.file(
    join(root, '.metadata/components.json'),
  ).json();
  const configurationPath = join(root, 'tsconfig.json');
  const configuration = ts.readConfigFile(configurationPath, (path) => ts.sys.readFile(path));
  if (configuration.error) throw new Error(`Unable to read ${configurationPath}`);
  const { options } = ts.parseJsonConfigFileContent(configuration.config, ts.sys, root);
  const typesFiles = manifest.components.map(({ id }) =>
    join(root, 'src/components', id, `${id}.types.ts`),
  );
  const program = ts.createProgram(typesFiles, options);
  const checker = program.getTypeChecker();
  const dom = program.getSourceFiles().find((file) => basename(file.fileName) === 'lib.dom.d.ts');
  const htmlElement =
    dom && checker.resolveName('HTMLElement', dom, ts.SymbolFlags.Interface, false);
  if (!htmlElement) throw new Error('Unable to resolve HTMLElement for custom element properties');
  const nativeProperties = new Set(
    checker
      .getDeclaredTypeOfSymbol(htmlElement)
      .getProperties()
      .map((property) => property.name),
  );

  return Promise.all(
    manifest.components.map(async ({ id, name, artifacts }, index) => {
      const path = typesFiles[index];
      const file = path && program.getSourceFile(path);
      const module = file && checker.getSymbolAtLocation(file);
      if (!module) throw new Error(`Missing types for ${id}`);
      const exported = checker.getExportsOfModule(module);
      const declaration =
        exported.find((symbol) => symbol.name === `${name}Props`) ??
        exported.find((symbol) => symbol.name === `${name}SchemaProps`);
      if (!declaration) throw new Error(`Missing props declaration for ${id}`);
      const declarationNode = declaration.declarations?.find(
        (node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node),
      );
      const explicitArguments = declarationNode?.typeParameters?.flatMap((parameter) => {
        if (parameter.default) return [];
        if (parameter.constraint)
          throw new Error(`Cannot instantiate constrained browser props for ${id}`);
        return ['unknown'];
      });
      const typeArguments = explicitArguments?.length ? `<${explicitArguments.join(', ')}>` : '';
      const schema: ComponentSchemaOutput = await Bun.file(join(root, artifacts.schema)).json();
      const properties = new Map(Object.entries(schema.properties));
      const propsType = checker.getDeclaredTypeOfSymbol(declaration);
      const members = propsType.isUnion() ? propsType.types : [propsType];
      const definitions: Record<string, PropertyOptions> = {};
      const names = new Set([
        ...properties.keys(),
        ...(schema.metadata?.unsupportedProps ?? []).map((property) => property.name),
        ...[...formAttributes.keys()].filter((property) =>
          members.some((member) => member.getProperty(property) !== undefined),
        ),
      ]);
      for (const source of names) {
        const renderer = members.some((member) => {
          const property = member.getProperty(source);
          return (
            property !== undefined &&
            hasSnippet(
              checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? file),
            )
          );
        });
        const identifier = source.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        const property = renderer
          ? prefixed('render', identifier)
          : nativeProperties.has(identifier)
            ? prefixed('component', identifier)
            : identifier;
        const shape = properties.get(source);
        const type = shape ? attributeType(shape) : formAttributes.get(source);
        const attribute = kebabCase(property);
        if (!/^[A-Za-z_$][\w$]*$/.test(property) || Object.hasOwn(definitions, property))
          throw new Error(`Duplicate or invalid Web Component property ${id}.${property}`);
        definitions[property] = {
          ...(source === property ? {} : { source }),
          ...(renderer ? { renderer: true } : {}),
          ...(attribute === property ? {} : { attribute }),
          ...(type === undefined ? {} : { type }),
        };
      }
      return { id, propsType: declaration.name + typeArguments, properties: definitions };
    }),
  );
}
