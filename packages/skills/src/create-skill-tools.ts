import { createTool } from '@corvidae/armorer';
import type { TypedEventTarget } from '@corvidae/lifecycle';
import { z } from 'zod';

import { refusedByAdmissionPolicy } from './admission';
import { escapeXml } from './create-skill-catalog-hook';
import type { SkillEventCorrelation, SkillEventMap } from './events';
import {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './events';
import type { SkillGuardrailOptions } from './guardrail';
import { scanSkillResource } from './guardrail';
import type { SkillSession } from './skill-session';
import type { SkillProvider, ToolPolicy } from './types';

// ── Types ────────────────────────────────────────────────────────────

export interface CreateSkillToolsOptions {
  /** Skill provider. */
  provider: SkillProvider;
  /** Session tracker for active skills. */
  session: SkillSession;
  /**
   * Runs a skill's body (on activation) and its resources (on load) through
   * the shared guardrail detector pipeline before they're returned to the
   * model. Omit to skip scanning entirely.
   */
  guardrail?: SkillGuardrailOptions;
  /**
   * Dispatch target for skill lifecycle events (COR-767). Omit to emit
   * nothing — a caller with no event surface (a headless script, a test) gets
   * no dispatch and no error, the same optional-emitter shape the schedule
   * lifecycle events use in `@corvidae/operative`.
   */
  events?: TypedEventTarget<SkillEventMap>;
  /**
   * Admission policy over skill NAMES (COR-752, Decision 1: Bureau owns "global
   * restriction of which skills exist for a run"). Before this, the same policy
   * was applied only to the rendered catalog, so a skill filtered out of the
   * listing could still be activated by name — the listing was cosmetic, not a
   * gate. Activation now consults it.
   *
   * Note the members are skill names, not tool names, even though the shape is
   * currently `ToolPolicy`. COR-752's Decision 3 calls for a distinct
   * skill-scoped type; that rename is its own boundary and is not done here.
   */
  admissionPolicy?: ToolPolicy;
  /**
   * Correlation stamped onto every event this toolbox dispatches. The tools
   * themselves have no access to the owning run or session, so the composer
   * supplies it.
   */
  correlation?: SkillEventCorrelation;
}

// ── Tools ────────────────────────────────────────────────────────────

/**
 * Creates a tool that activates a skill by name.
 * Loads the skill content and marks it as active in the session.
 *
 * When `options.guardrail` is provided, the skill's body is scanned before
 * activation. A blocked skill is never marked active and its content never
 * reaches the model.
 */
export function createActivateSkillTool(options: CreateSkillToolsOptions) {
  const { provider, session, guardrail, events, correlation = {}, admissionPolicy } = options;

  return createTool({
    name: 'activate_skill',
    description:
      'Activate a skill by name. Returns the skill instructions and lists available resources.',
    input: z.object({
      name: z.string().describe('The skill name to activate'),
    }),
    async execute(params) {
      if (session.isActive(params.name)) {
        return { alreadyActive: true, name: params.name };
      }

      // Admission before existence: a skill the policy refuses must not reveal
      // through a different error whether it exists at all.
      const refusedBy = refusedByAdmissionPolicy(params.name, admissionPolicy);
      if (refusedBy) {
        events?.dispatch(
          new SkillRejectedEvent(params.name, 'ownership-policy', correlation, refusedBy),
        );
        return { error: 'Skill is not permitted', name: params.name };
      }

      const enabled = await provider.isEnabled(params.name);
      if (!enabled) {
        events?.dispatch(new SkillRejectedEvent(params.name, 'disabled', correlation));
        return { error: 'Skill is disabled', name: params.name };
      }

      const skill = await provider.loadSkill(params.name);
      if (!skill) {
        events?.dispatch(new SkillFailedEvent(params.name, correlation));
        return { error: 'Skill not found', name: params.name };
      }

      // The instructions exist; whether they enter context is still undecided.
      events?.dispatch(new SkillLoadedEvent(params.name, correlation));

      if (guardrail) {
        const scan = await scanSkillResource(skill.body, guardrail);
        if (scan.blocked) {
          events?.dispatch(new SkillRejectedEvent(params.name, 'guardrail-blocked', correlation));
          return {
            error: 'Skill content blocked by guardrail',
            name: params.name,
            category: scan.event?.category,
            detail: scan.event?.detail,
          };
        }
      }

      const resources = await provider.listResources(params.name);
      session.activate(params.name, skill.metadata.toolPolicy);
      events?.dispatch(new SkillActivatedEvent(params.name, correlation));

      const escapedName = escapeXml(params.name);
      let xml = `<skill_content name="${escapedName}">\n${skill.body}`;

      if (resources.length > 0) {
        const resourceElements = resources
          .map((path) => `  <file>${escapeXml(path)}</file>`)
          .join('\n');
        xml += `\n\nSkill resources:\n<skill_resources>\n${resourceElements}\n</skill_resources>`;
      }

      xml += '\n</skill_content>';

      return xml;
    },
  });
}

/**
 * Creates a tool that loads a specific resource from an active skill.
 *
 * When `options.guardrail` is provided, the resource content is scanned
 * before being returned; a blocked resource is never returned to the model.
 */
export function createLoadSkillResourceTool(options: CreateSkillToolsOptions) {
  const { provider, session, guardrail } = options;

  return createTool({
    name: 'load_skill_resource',
    description: 'Load a resource file from an active skill.',
    input: z.object({
      skillName: z.string().describe('The skill name'),
      path: z.string().describe('The resource path within the skill'),
    }),
    async execute(params) {
      if (!session.isActive(params.skillName)) {
        return { error: 'Skill is not active', skillName: params.skillName };
      }

      const bytes = await provider.loadResource(params.skillName, params.path);
      if (bytes === undefined) {
        return {
          error: 'Resource not found',
          skillName: params.skillName,
          path: params.path,
        };
      }

      // Decoded here and only here: the model consumes text, while storage keeps the exact bytes
      // so a binary asset survives the round trip.
      //
      // `fatal: true` is the security-relevant part, not a nicety. A lossy decode would turn a
      // binary asset into replacement characters and then hand *that* to the guardrail, which
      // scans it as meaningless garbage and passes it — a resource effectively skipping the scan
      // while appearing to have been scanned. Refusing instead means the rule has no hole in it:
      // either a resource decodes losslessly and is scanned, or it does not reach the model at
      // all. A model cannot consume a PNG anyway, so nothing legitimate is lost.
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return {
          error: 'Resource is not UTF-8 text and cannot be admitted to context',
          skillName: params.skillName,
          path: params.path,
        };
      }

      if (guardrail) {
        const scan = await scanSkillResource(content, guardrail);
        if (scan.blocked) {
          return {
            error: 'Resource blocked by guardrail',
            skillName: params.skillName,
            path: params.path,
            category: scan.event?.category,
            detail: scan.event?.detail,
          };
        }
        return { content: scan.content, ...(scan.flagged ? { flagged: true as const } : {}) };
      }

      return { content };
    },
  });
}

/**
 * Creates a tool that deactivates a skill.
 */
export function createDeactivateSkillTool(options: CreateSkillToolsOptions) {
  const { session, events, correlation = {} } = options;

  return createTool({
    name: 'deactivate_skill',
    description: 'Deactivate a skill, removing it from the active set.',
    input: z.object({
      name: z.string().describe('The skill name to deactivate'),
    }),
    execute(params) {
      const result: { deactivated: boolean; name: string } = {
        deactivated: false,
        name: params.name,
      };

      if (session.isActive(params.name)) {
        session.deactivate(params.name);
        result.deactivated = true;
        events?.dispatch(new SkillDeactivatedEvent(params.name, correlation));
      }

      return Promise.resolve(result);
    },
  });
}

/**
 * Creates a tool that lists all available skills with active status.
 */
export function createListSkillsTool(options: CreateSkillToolsOptions) {
  const { provider, session } = options;

  return createTool({
    name: 'list_skills',
    description: 'List all available skills with their active status.',
    input: z.object({}),
    async execute() {
      const entries = await provider.listSkills();
      const skills = entries.map((entry) => ({
        ...entry,
        active: session.isActive(entry.name),
      }));
      return { skills };
    },
  });
}

// ── Convenience Factory ──────────────────────────────────────────────

/**
 * Creates all skill management tools bundled together.
 */
export function createSkillToolbox(options: CreateSkillToolsOptions) {
  return {
    activateSkill: createActivateSkillTool(options),
    loadSkillResource: createLoadSkillResourceTool(options),
    deactivateSkill: createDeactivateSkillTool(options),
    listSkills: createListSkillsTool(options),
  };
}

// ── Predicates ───────────────────────────────────────────────────────

/**
 * Predicate that checks if a message string contains skill content.
 * Used by context compactors to exempt skill content from pruning.
 */
export function isSkillContent(message: string): boolean {
  return message.includes('<skill_content ');
}
