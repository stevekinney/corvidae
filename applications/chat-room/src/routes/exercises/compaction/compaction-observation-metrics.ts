import type { Message } from '@repo/chat';

export function messageShape(message: Message): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    metadata: message.metadata,
  });
}

export function snapshotMessages(messages: readonly Message[]): string {
  return JSON.stringify(messages);
}

export function distinctStrings(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function chunkRangesOf(chunkSeedPositions: readonly (readonly number[])[]): string {
  return chunkSeedPositions
    .map((positions) => {
      const low = Math.min(...positions);
      const high = Math.max(...positions);
      return low === high ? `${low}` : `${low}-${high}`;
    })
    .join(', ');
}

function chunkIsAscending(positions: readonly number[]): boolean {
  return positions.every(
    (position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)),
  );
}

export function chunksAreChronological(
  chunkSeedPositions: readonly (readonly number[])[],
): boolean {
  return (
    chunkSeedPositions.length > 0 &&
    chunkSeedPositions.every((positions, chunk) => {
      if (positions.length === 0 || !chunkIsAscending(positions)) return false;
      return (
        chunk === 0 || Math.min(...positions) > Math.max(...(chunkSeedPositions[chunk - 1] ?? []))
      );
    })
  );
}

export function summaryOrderOf(
  markers: readonly string[],
  markerPositions: readonly number[],
): string {
  return markers
    .map((_, index) => ({ call: index + 1, at: markerPositions[index] }))
    .filter(
      (entry): entry is { call: number; at: number } => entry.at !== undefined && entry.at >= 0,
    )
    .toSorted((first, second) => first.at - second.at)
    .map((entry) => entry.call)
    .join(', ');
}

export function summariesAreInOrder(markerPositions: readonly number[]): boolean {
  return (
    markerPositions.length > 0 &&
    markerPositions.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > (markerPositions[index - 1] ?? -1)),
    )
  );
}

export function controlWasSummarized(input: {
  control: Message | undefined;
  summarizedIds: readonly string[];
  projectionShapes: readonly string[];
}): boolean {
  return (
    input.control !== undefined &&
    input.summarizedIds.includes(input.control.id) &&
    !input.projectionShapes.includes(messageShape(input.control))
  );
}

export function partitionIsExact(input: {
  beforeLength: number;
  carriedVerbatim: number;
  inBothBuckets: number;
  inNeitherBucket: number;
  injectedSummaries: number;
  projectionLength: number;
  summarizedCount: number;
}): boolean {
  return (
    input.inBothBuckets === 0 &&
    input.inNeitherBucket === 0 &&
    input.carriedVerbatim + input.summarizedCount === input.beforeLength &&
    input.carriedVerbatim + input.injectedSummaries === input.projectionLength
  );
}

export function countRawSummarizedInProjection(input: {
  before: readonly Message[];
  summarizedIds: readonly string[];
  projectionText: string;
}): number {
  return input.before.filter(
    (message) =>
      input.summarizedIds.includes(message.id) &&
      input.projectionText.includes(JSON.stringify(message.content).slice(1, -1)),
  ).length;
}

export function allSummariesReachProjection(input: {
  markers: readonly string[];
  projection: readonly Message[];
}): boolean {
  return (
    input.markers.length > 0 &&
    input.markers.every((marker) =>
      input.projection.some((message) => JSON.stringify(message.content).includes(marker)),
    )
  );
}

export function summarizerInputsAreIntact(input: {
  beforeShapes: readonly string[];
  seededIds: readonly string[];
  summarizerInputs: readonly { id: string; shape: string }[];
}): boolean {
  return (
    input.summarizerInputs.length > 0 &&
    input.summarizerInputs.every(({ id, shape }) => {
      const seededIndex = input.seededIds.indexOf(id);
      return seededIndex >= 0 && input.beforeShapes[seededIndex] === shape;
    })
  );
}

export function errorNameOf(error: unknown): string {
  if (error === undefined) return '(none)';
  return error instanceof Error ? error.name : `(non-Error: ${typeof error})`;
}
