import type { CatalogOperationSnapshot } from '../src/operation-catalog-snapshot.ts';
import { GENERATED_HEADER } from './operation-client-domains.ts';

/** Generate bindings only for operations that declare consumer behavior. */
export function svelteClientSource(
  operations: readonly CatalogOperationSnapshot[],
  subscriptions: readonly CatalogOperationSnapshot[],
  outputFile: string,
  serverName: string,
): string {
  const usedNames = new Set<string>();
  const declaredReads = operations
    .filter((operation) => operation.kind === 'unary' && operation.behavior?.kind === 'read')
    .map((operation) => operation.name);
  const bindingName = (operation: CatalogOperationSnapshot) => {
    const name = operation.name
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join('');
    if (!name || usedNames.has(name))
      throw new Error(`Svelte binding name collision for ${operation.name}`);
    usedNames.add(name);
    return name;
  };
  const bindings = operations.flatMap((operation) => {
    const behavior = operation.behavior;
    if (!behavior) return [];
    const name = bindingName(operation);
    const type = `ClientOperationTypes[${JSON.stringify(operation.name)}]`;
    if (behavior.kind === 'read')
      return [
        `export function use${name}(host: CatalogHost, input: () => ${type}['input']) {
  const read = createReactiveRead<${type}['input'], ${type}['output']>(host, ${JSON.stringify(operation.name)}, input);
  return ${behavior.pagination ? `Object.assign(read, createPagination(host, ${JSON.stringify(operation.name)}, input, ${JSON.stringify(behavior.pagination)}))` : 'read'};
}`,
      ];
    for (const target of behavior.invalidates ?? []) {
      if (!declaredReads.includes(target))
        throw new Error(`Command ${operation.name} invalidates undeclared read ${target}`);
    }
    return [
      `export function use${name}(host: CatalogHost) {
  return createCommand<${type}['input'], ${type}['output']>(host, ${JSON.stringify(operation.name)}, ${JSON.stringify(behavior.invalidates ?? [])}${behavior.invalidates?.length ? '' : `, ${JSON.stringify(declaredReads)}`});
}`,
    ];
  });
  const streams = subscriptions
    .filter((operation) => operation.behavior?.kind === 'read' && operation.behavior.cursor)
    .map((operation) => {
      const name = bindingName(operation);
      const type = `SubscriptionOperationTypes[${JSON.stringify(operation.name)}]`;
      return `export function use${name}(host: CatalogHost, input: ${type}['input'], onEvent: (event: ${type}['event']) => void) {
  return createSubscription(host, ${JSON.stringify(operation.name)}, input, onEvent);
}`;
    });
  const provider = serverName.replace(/[^A-Za-z0-9]/gu, '');
  if (!/^[A-Za-z]/u.test(provider))
    throw new Error('Svelte provider name must start with a letter');
  return `${GENERATED_HEADER}
import { createReactiveRead, createCommand, ${operations.some((operation) => operation.behavior?.kind === 'read' && operation.behavior.pagination) ? 'createPagination, ' : ''}${streams.length ? 'createSubscription, ' : ''}type CatalogHost } from '@lostgradient/backchannel-svelte';
import type { ClientOperationTypes } from './${outputFile}';
${streams.length ? "import type { SubscriptionOperationTypes } from './subscription-operations.generated.ts';" : ''}
export { default as ${provider}Provider } from '@lostgradient/backchannel-svelte/provider';
export { getCatalogHost as get${provider}Host } from '@lostgradient/backchannel-svelte';
${[...bindings, ...streams].join('\n\n')}
`;
}
