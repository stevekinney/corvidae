import { parse } from 'svelte/compiler';
import type { PropertyOptions } from './web-component-catalog.ts';

/** Observe the source's bindable state without evaluating its defaults in the wrapper. */
export function observeBrowserBindings(
  source: string,
  properties: Record<string, PropertyOptions>,
) {
  if (!source.includes('$bindable')) return undefined;
  const script = parse(source, { modern: true }).instance;
  if (!script) return undefined;
  const { content } = script;
  if (
    !('start' in content) ||
    !('end' in content) ||
    typeof content.start !== 'number' ||
    typeof content.end !== 'number'
  )
    throw new Error('Missing script source positions for browser bindings');
  const names = new Map(
    Object.entries(properties).map(([name, property]) => [property.source ?? name, name]),
  );

  for (const statement of script.content.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (
        declaration.id.type !== 'ObjectPattern' ||
        declaration.init?.type !== 'CallExpression' ||
        declaration.init.callee.type !== 'Identifier' ||
        declaration.init.callee.name !== '$props'
      )
        continue;
      const effects = declaration.id.properties.flatMap((property) => {
        if (
          property.type !== 'Property' ||
          property.key.type !== 'Identifier' ||
          property.value.type !== 'AssignmentPattern' ||
          property.value.left.type !== 'Identifier' ||
          property.value.right.type !== 'CallExpression' ||
          property.value.right.callee.type !== 'Identifier' ||
          property.value.right.callee.name !== '$bindable'
        )
          return [];
        const name = names.get(property.key.name);
        if (!name) return [];
        return [
          `$effect(() => {
  const cinderBindableValue = ${property.value.left.name};
  cinderUntrackBindable(() => cinderPublishBindable?.(${JSON.stringify(name)}, cinderBindableValue));
});`,
        ];
      });
      if (effects.length === 0) continue;
      if (!('start' in declaration.id) || typeof declaration.id.start !== 'number')
        throw new Error('Missing destructuring source position for browser bindings');
      const { start } = declaration.id;
      return [
        source.slice(0, content.start),
        "import { untrack as cinderUntrackBindable } from 'svelte';\n",
        source.slice(content.start, start + 1),
        'cinderPublishBindable,',
        source.slice(start + 1, content.end),
        '\n' + effects.join('\n') + '\n',
        source.slice(content.end),
      ].join('');
    }
  }
  return undefined;
}
