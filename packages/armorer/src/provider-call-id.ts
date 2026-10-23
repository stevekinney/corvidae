/**
 * The `providerCallId` field to spread into a call or result that is derived from `source`: the id
 * the model provider issued for the call, or nothing when Armorer generated the id. Every
 * projection that rebuilds a call or a result spreads this, so the marker is not dropped on the way
 * to a provider formatter.
 */
export function providerCallIdField(
  source: object | undefined,
): { providerCallId: string } | Record<never, never> {
  const id: unknown = source === undefined ? undefined : Reflect.get(source, 'providerCallId');
  return typeof id === 'string' && id.length > 0 ? { providerCallId: id } : {};
}
