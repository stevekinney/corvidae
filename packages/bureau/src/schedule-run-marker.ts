export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export type RecoveredScheduleMarker =
  | { status: 'found'; scheduleId: string }
  | { status: 'missing'; sessionId?: string }
  | { status: 'read-error'; error: unknown; sessionId?: string };
