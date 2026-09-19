import type { EventMap } from '@corvidae/lifecycle';

/**
 * Skill lifecycle events (COR-767). Before these, every skill transition was
 * silent: AB-87's matrix recorded the `skills` surface as a declared gap with
 * no `Event` subclass anywhere in the package.
 *
 * All five carry the skill name and the correlation the caller supplies. They
 * are dispatched from the `@corvidae/skills` tool factories, which COR-1226
 * made the single production path — before that, Bureau ran its own inline
 * copy of these tools, so an event emitted here would never have fired.
 *
 * Deliberately NOT covered here: resource loading (`load_skill_resource`).
 * That is the tier-3 progressive-disclosure step, not a skill lifecycle
 * transition — a skill is already active before any resource is read, and a
 * blocked resource does not deactivate it. `skill.loaded` below means the
 * skill's own instructions were loaded, not a bundled file.
 */

/** Correlation carried by every skill lifecycle event. */
export interface SkillEventCorrelation {
  /** The consuming run, when the dispatch site knows it. */
  runId?: string | undefined;
  /** The owning session, when the dispatch site knows it. */
  sessionId?: string | undefined;
}

/**
 * The skill's instructions were loaded from the provider. Fires before the
 * guardrail scan and before the session admits the skill, so a skill that is
 * loaded and then blocked produces `skill.loaded` followed by
 * `skill.rejected` and never `skill.activated`. That ordering is the point:
 * it separates "the provider had it" from "it entered context".
 */
export class SkillLoadedEvent extends Event {
  static readonly type = 'skill.loaded' as const;
  readonly skillName: string;
  readonly correlation: SkillEventCorrelation;
  constructor(skillName: string, correlation: SkillEventCorrelation = {}) {
    super(SkillLoadedEvent.type);
    this.skillName = skillName;
    this.correlation = correlation;
  }
  override get type(): typeof SkillLoadedEvent.type {
    return SkillLoadedEvent.type;
  }
}

/**
 * The skill was admitted to the session and its instructions returned to the
 * model. Fires after every gate the activation path applies.
 */
export class SkillActivatedEvent extends Event {
  static readonly type = 'skill.activated' as const;
  readonly skillName: string;
  readonly correlation: SkillEventCorrelation;
  constructor(skillName: string, correlation: SkillEventCorrelation = {}) {
    super(SkillActivatedEvent.type);
    this.skillName = skillName;
    this.correlation = correlation;
  }
  override get type(): typeof SkillActivatedEvent.type {
    return SkillActivatedEvent.type;
  }
}

/**
 * The skill left the active set. Fires only when a previously active skill is
 * actually deactivated — deactivating an inactive skill is a no-op and emits
 * nothing, matching what the tool itself reports through `deactivated: false`.
 */
export class SkillDeactivatedEvent extends Event {
  static readonly type = 'skill.deactivated' as const;
  readonly skillName: string;
  readonly correlation: SkillEventCorrelation;
  constructor(skillName: string, correlation: SkillEventCorrelation = {}) {
    super(SkillDeactivatedEvent.type);
    this.skillName = skillName;
    this.correlation = correlation;
  }
  override get type(): typeof SkillDeactivatedEvent.type {
    return SkillDeactivatedEvent.type;
  }
}

/**
 * Why an activation attempt was refused before admission.
 *
 * A closed union rather than a free-text reason, following
 * `RecoveryRejectionReason` in `@corvidae/bureau` — and for the same purpose,
 * so a consumer can branch on the cause without parsing prose. The guardrail's
 * own `category`/`detail` stay off this event for the reason
 * `ReviewRejectedEvent` keeps a decision's reason off the public event: the
 * detail belongs in the privileged, separately-redacted surface, not in a
 * general lifecycle event.
 *
 * `'ownership-policy'` was added once COR-752 defined the gate: Bureau's
 * `skillPolicy` is an admission decision, not merely a catalog filter, and a
 * denial names which of its two rules refused the skill.
 */
export type SkillRejectionReason = 'disabled' | 'guardrail-blocked' | 'ownership-policy';

/**
 * Which rule of the admission policy refused an activation. Carried only on an
 * `'ownership-policy'` rejection, and deliberately an identity rather than the
 * policy's contents: a consumer can branch on which rule fired without the
 * event disclosing the configured allow or deny lists.
 *
 * `'allow-list'` — an allow list is configured and the skill is not on it.
 * `'deny-list'` — the skill appears on the deny list.
 */
export type SkillAdmissionRule = 'allow-list' | 'deny-list';

/**
 * An activation attempt was refused before the skill entered context.
 * Mutually exclusive with {@link SkillFailedEvent} for one attempt: rejection
 * is a pre-admission policy outcome, failure is a runtime fault.
 */
export class SkillRejectedEvent extends Event {
  static readonly type = 'skill.rejected' as const;
  readonly skillName: string;
  readonly reason: SkillRejectionReason;
  /**
   * The admission rule that refused the skill. Set only when `reason` is
   * `'ownership-policy'`; undefined for every other reason, which have no rule
   * to name.
   */
  readonly rule: SkillAdmissionRule | undefined;
  readonly correlation: SkillEventCorrelation;
  constructor(
    skillName: string,
    reason: SkillRejectionReason,
    correlation: SkillEventCorrelation = {},
    rule?: SkillAdmissionRule,
  ) {
    super(SkillRejectedEvent.type);
    this.skillName = skillName;
    this.reason = reason;
    this.correlation = correlation;
    this.rule = rule;
  }
  override get type(): typeof SkillRejectedEvent.type {
    return SkillRejectedEvent.type;
  }
}

/**
 * An activation attempt could not complete because the skill was not there to
 * admit — the provider returned nothing for that name. Distinct from
 * {@link SkillRejectedEvent}, which is a policy refusal of a skill that does
 * exist. One attempt produces at most one of the two, never both.
 */
export class SkillFailedEvent extends Event {
  static readonly type = 'skill.failed' as const;
  readonly skillName: string;
  readonly correlation: SkillEventCorrelation;
  constructor(skillName: string, correlation: SkillEventCorrelation = {}) {
    super(SkillFailedEvent.type);
    this.skillName = skillName;
    this.correlation = correlation;
  }
  override get type(): typeof SkillFailedEvent.type {
    return SkillFailedEvent.type;
  }
}

/**
 * Maps each event type string to its class. Deliberately does NOT extend
 * `EventMap` — the same split `FileSynchronizerEventClassMap` uses in
 * `@corvidae/memory`, because a type that extends an index signature has its
 * `keyof` collapse to `string`, which would let a typo'd literal through.
 */
export interface SkillEventClassMap {
  [SkillLoadedEvent.type]: SkillLoadedEvent;
  [SkillActivatedEvent.type]: SkillActivatedEvent;
  [SkillDeactivatedEvent.type]: SkillDeactivatedEvent;
  [SkillRejectedEvent.type]: SkillRejectedEvent;
  [SkillFailedEvent.type]: SkillFailedEvent;
}

export interface SkillEventMap extends SkillEventClassMap, EventMap {}

export type SkillEventType = Extract<keyof SkillEventClassMap, string>;
