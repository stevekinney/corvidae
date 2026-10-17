/**
 * Descriptive metadata for one capability an agent offers.
 *
 * The shape follows A2A's `AgentSkill` (specification section 4.4.5,
 * https://a2a-protocol.org/latest/specification/), so a later Agent Card can
 * carry it unchanged: `id`, `name`, `description`, and `tags` are required, and
 * `examples`, `inputModes`, and `outputModes` are optional. `securityRequirements`
 * is deliberately omitted.
 *
 * This is pure description. It is unrelated to `AgentSkills` (`agent-policy.ts`),
 * the runtime skill-catalog seam behind `createAgent({ skills })`, which gives a
 * run activatable instructions and tools.
 */
export interface AgentSkillDescriptor {
  /** A unique identifier for the skill within its agent. */
  readonly id: string;
  /** A human-readable name for the skill. */
  readonly name: string;
  /** A detailed description of what the skill does. */
  readonly description: string;
  /** Keywords describing the skill's capabilities. */
  readonly tags: readonly string[];
  /** Example prompts or scenarios this skill can handle. */
  readonly examples?: readonly string[];
  /** Media types the skill accepts, for example `text/plain`. */
  readonly inputModes?: readonly string[];
  /** Media types the skill produces, for example `application/json`. */
  readonly outputModes?: readonly string[];
}
