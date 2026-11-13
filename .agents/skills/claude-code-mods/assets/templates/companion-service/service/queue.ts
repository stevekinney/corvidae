import type { AttentionItem, PresenceRequest } from '../plugin/hooks/protocol.ts';

/** A heartbeat as the service keeps it: the request plus when it arrived. */
export type Presence = PresenceRequest & { receivedAt: number };

export type QueueLimits = { maximumItems: number; presenceLifetimeMilliseconds: number };

export type Queue = {
  /** Adds an item or refreshes one with the same id; resubmitting is safe (at-least-once delivery). */
  upsert: (item: Omit<AttentionItem, 'acknowledgedAt'>) => 'created' | 'updated';
  acknowledge: (id: string, at: number) => 'acknowledged' | 'already-acknowledged' | 'missing';
  list: () => AttentionItem[];
  /** Records a heartbeat unless it is older than one already recorded from the same instance. */
  recordPresence: (presence: PresenceRequest, receivedAt: number) => 'recorded' | 'stale';
  livePresence: (now: number) => Presence[];
};

export const DEFAULT_LIMITS: QueueLimits = {
  maximumItems: 500,
  presenceLifetimeMilliseconds: 45_000,
};

/**
 * An in-memory queue. A real deployment that needs claims, leases, or recovery
 * after a restart keeps this state in durable storage (SQLite, Postgres)
 * instead; nothing here survives the process.
 */
export function createQueue(limits: QueueLimits = DEFAULT_LIMITS): Queue {
  const items = new Map<string, AttentionItem>();
  const presence = new Map<string, Presence>();

  function evictOverflow(): void {
    while (items.size > limits.maximumItems) {
      const ordered = [...items.values()].toSorted(
        (left, right) => left.createdAt - right.createdAt,
      );
      const victim = ordered.find((item) => item.acknowledgedAt !== null) ?? ordered[0];
      if (victim === undefined) return;
      items.delete(victim.id);
    }
  }

  return {
    upsert: (item) => {
      const existing = items.get(item.id);
      // A resubmission keeps the first creation time and any acknowledgement,
      // so a producer's retry never re-opens something a person already handled.
      items.set(item.id, {
        ...item,
        createdAt: existing?.createdAt ?? item.createdAt,
        acknowledgedAt: existing?.acknowledgedAt ?? null,
      });
      evictOverflow();
      return existing === undefined ? 'created' : 'updated';
    },
    acknowledge: (id, at) => {
      const existing = items.get(id);
      if (existing === undefined) return 'missing';
      if (existing.acknowledgedAt !== null) return 'already-acknowledged';
      items.set(id, { ...existing, acknowledgedAt: at });
      return 'acknowledged';
    },
    list: () => [...items.values()].toSorted((left, right) => left.createdAt - right.createdAt),
    recordPresence: (heartbeat, receivedAt) => {
      const existing = presence.get(heartbeat.sessionId);
      const isSameInstance = existing?.instanceId === heartbeat.instanceId;
      if (existing !== undefined && isSameInstance && existing.sequence >= heartbeat.sequence)
        return 'stale';
      // A new instance id (the mod reloaded) replaces the old one outright.
      presence.set(heartbeat.sessionId, { ...heartbeat, receivedAt });
      return 'recorded';
    },
    livePresence: (now) => {
      for (const [sessionId, heartbeat] of presence) {
        if (now - heartbeat.receivedAt > limits.presenceLifetimeMilliseconds)
          presence.delete(sessionId);
      }
      return [...presence.values()];
    },
  };
}
