export const CATALOG_OPERATION_BEHAVIORS = {
  'bureau.agents.catalog': {
    mcpExposable: false,
  },
  'bureau.agents.definitions.create': {
    mcpExposable: false,
  },
  'bureau.agents.definitions.delete': {
    mcpExposable: false,
  },
  'bureau.agents.definitions.duplicate': {
    mcpExposable: false,
  },
  'bureau.agents.definitions.get': {
    mcpExposable: false,
  },
  'bureau.agents.definitions.list': {
    mcpExposable: false,
  },
  'bureau.agents.definitions.revisions': {
    mcpExposable: false,
  },
  'bureau.agents.definitions.update': {
    mcpExposable: false,
  },
  'bureau.agents.disable': {
    mcpExposable: false,
  },
  'bureau.agents.enable': {
    mcpExposable: false,
  },
  'bureau.agents.list': {
    mcpExposable: true,
  },
  'bureau.agents.models': {
    mcpExposable: false,
  },
  'bureau.agents.overrides.get': {
    mcpExposable: false,
  },
  'bureau.agents.overrides.update': {
    mcpExposable: false,
  },
  'bureau.agents.references': {
    mcpExposable: false,
  },
  'bureau.agents.try': {
    mcpExposable: false,
  },
  'bureau.agents.versions.list': {
    mcpExposable: false,
  },
  'bureau.agents.versions.restore': {
    mcpExposable: false,
  },
  'bureau.assets.get': {
    mcpExposable: false,
  },
  'bureau.assets.uploads.abort': {
    mcpExposable: false,
  },
  'bureau.assets.uploads.append': {
    mcpExposable: false,
  },
  'bureau.assets.uploads.complete': {
    mcpExposable: false,
  },
  'bureau.assets.uploads.create': {
    mcpExposable: false,
  },
  'bureau.audit.query': {
    mcpExposable: false,
  },
  'bureau.checks.list': {
    mcpExposable: false,
  },
  'bureau.contexts.archive': {
    mcpExposable: false,
  },
  'bureau.contexts.delete': {
    mcpExposable: false,
  },
  'bureau.contexts.forgetgrants': {
    mcpExposable: false,
  },
  'bureau.contexts.fork': {
    mcpExposable: false,
  },
  'bureau.contexts.get': {
    mcpExposable: true,
  },
  'bureau.contexts.input': {
    mcpExposable: true,
  },
  'bureau.contexts.list': {
    mcpExposable: true,
  },
  'bureau.contexts.regenerate': {
    mcpExposable: false,
  },
  'bureau.contexts.rename': {
    mcpExposable: false,
  },
  'bureau.contexts.retract': {
    mcpExposable: false,
  },
  'bureau.contexts.steer': {
    mcpExposable: false,
  },
  'bureau.contexts.unarchive': {
    mcpExposable: false,
  },
  'bureau.contexts.window': {
    mcpExposable: false,
  },
  'bureau.decisions.decide': {
    mcpExposable: false,
  },
  'bureau.decisions.models': {
    mcpExposable: false,
  },
  'bureau.deployment.get': {
    mcpExposable: false,
  },
  'bureau.deployments.get': {
    mcpExposable: false,
  },
  'bureau.deployments.promote': {
    mcpExposable: false,
  },
  'bureau.deployments.ramp': {
    mcpExposable: false,
  },
  'bureau.deployments.rollback': {
    mcpExposable: false,
  },
  'bureau.diagnostics.get': {
    mcpExposable: false,
  },
  'bureau.events': {
    mcpExposable: false,
  },
  'bureau.events.catalog': {
    mcpExposable: false,
  },
  'bureau.events.format': {
    mcpExposable: false,
  },
  'bureau.goals.cancel': {
    mcpExposable: false,
  },
  'bureau.goals.create': {
    mcpExposable: false,
  },
  'bureau.goals.get': {
    mcpExposable: true,
  },
  'bureau.goals.list': {
    mcpExposable: true,
  },
  'bureau.goals.update': {
    mcpExposable: false,
  },
  'bureau.goals.verdict': {
    mcpExposable: false,
  },
  'bureau.guardrails.list': {
    mcpExposable: false,
  },
  'bureau.health.attention': {
    mcpExposable: false,
  },
  'bureau.hooks.create': {
    mcpExposable: false,
  },
  'bureau.hooks.delete': {
    mcpExposable: false,
  },
  'bureau.hooks.deliveries': {
    mcpExposable: false,
  },
  'bureau.hooks.deliveries.retry': {
    mcpExposable: false,
  },
  'bureau.hooks.draft.test': {
    mcpExposable: false,
  },
  'bureau.hooks.duplicate': {
    mcpExposable: false,
  },
  'bureau.hooks.get': {
    mcpExposable: false,
  },
  'bureau.hooks.list': {
    mcpExposable: false,
  },
  'bureau.hooks.secret.replace': {
    mcpExposable: false,
  },
  'bureau.hooks.test': {
    mcpExposable: false,
  },
  'bureau.hooks.update': {
    mcpExposable: false,
  },
  'bureau.memory.correct': {
    mcpExposable: false,
  },
  'bureau.memory.embedding': {
    mcpExposable: false,
  },
  'bureau.memory.embedding.cancel': {
    mcpExposable: false,
  },
  'bureau.memory.export': {
    mcpExposable: false,
  },
  'bureau.memory.forget': {
    mcpExposable: false,
  },
  'bureau.memory.get': {
    mcpExposable: false,
  },
  'bureau.memory.hold': {
    mcpExposable: false,
  },
  'bureau.memory.hold.release': {
    mcpExposable: false,
  },
  'bureau.memory.list': {
    mcpExposable: false,
  },
  'bureau.memory.quarantine': {
    mcpExposable: false,
  },
  'bureau.memory.quarantine.release': {
    mcpExposable: false,
  },
  'bureau.memory.remember': {
    mcpExposable: false,
  },
  'bureau.memory.search': {
    mcpExposable: false,
  },
  'bureau.memory.share': {
    mcpExposable: false,
  },
  'bureau.memory.share.revoke': {
    mcpExposable: false,
  },
  'bureau.notifications.dismiss': {
    mcpExposable: false,
  },
  'bureau.notifications.list': {
    mcpExposable: false,
  },
  'bureau.notifications.markread': {
    mcpExposable: false,
  },
  'bureau.plugins.contributions': {
    mcpExposable: false,
  },
  'bureau.reviews.get': {
    mcpExposable: true,
    behavior: {
      kind: 'read',
      key: ['id'],
    },
  },
  'bureau.reviews.list': {
    mcpExposable: true,
    behavior: {
      kind: 'read',
      pagination: {
        items: 'reviews',
        cursorInput: 'pageToken',
        nextCursor: 'nextPageToken',
        total: 'total',
        cursorFilters: ['status', 'resolvedAfter'],
        itemKey: ['source', 'id'],
      },
    },
  },
  'bureau.reviews.resolve': {
    mcpExposable: true,
    behavior: {
      kind: 'command',
      observedInput: {
        read: 'bureau.reviews.get',
        when: {
          kind: 'tool-approval',
          status: 'pending',
        },
        key: 'id',
        revision: 'round',
      },
      invalidates: ['bureau.reviews.list', 'bureau.reviews.get'],
      conflictReasons: [
        'REVIEW_ROUND_CHANGED',
        'REVIEW_ALREADY_RESOLVED',
        'APPROVAL_OUTCOME_NOT_WRITTEN',
      ],
    },
  },
  'bureau.runs.compare': {
    mcpExposable: true,
  },
  'bureau.runs.timeline': {
    mcpExposable: true,
  },
  'bureau.schedules.cancel': {
    mcpExposable: false,
  },
  'bureau.schedules.create': {
    mcpExposable: false,
  },
  'bureau.schedules.get': {
    mcpExposable: true,
  },
  'bureau.schedules.list': {
    mcpExposable: true,
  },
  'bureau.schedules.missed': {
    mcpExposable: false,
  },
  'bureau.schedules.pause': {
    mcpExposable: false,
  },
  'bureau.schedules.resume': {
    mcpExposable: false,
  },
  'bureau.schedules.runnow': {
    mcpExposable: false,
  },
  'bureau.schedules.skipnext': {
    mcpExposable: false,
  },
  'bureau.schedules.unskip': {
    mcpExposable: false,
  },
  'bureau.schedules.update': {
    mcpExposable: false,
  },
  'bureau.settings.events': {
    mcpExposable: false,
  },
  'bureau.settings.get': {
    mcpExposable: false,
  },
  'bureau.settings.schema': {
    mcpExposable: false,
  },
  'bureau.settings.update': {
    mcpExposable: false,
  },
  'bureau.skills.get': {
    mcpExposable: false,
  },
  'bureau.skills.list': {
    mcpExposable: false,
  },
  'bureau.tasks.cancel': {
    mcpExposable: true,
  },
  'bureau.tasks.events': {
    mcpExposable: true,
  },
  'bureau.tasks.explain': {
    mcpExposable: true,
  },
  'bureau.tasks.explanation.generate': {
    mcpExposable: false,
  },
  'bureau.tasks.explanation.get': {
    mcpExposable: false,
  },
  'bureau.tasks.get': {
    mcpExposable: true,
  },
  'bureau.tasks.inspect': {
    mcpExposable: true,
  },
  'bureau.tasks.list': {
    mcpExposable: true,
  },
  'bureau.tasks.respond': {
    mcpExposable: true,
  },
  'bureau.validators.list': {
    mcpExposable: false,
  },
  'bureau.workflows.catalog': {
    mcpExposable: false,
  },
  'bureau.workflows.concurrency': {
    mcpExposable: false,
  },
  'bureau.workflows.create': {
    mcpExposable: false,
  },
  'bureau.workflows.delete': {
    mcpExposable: false,
  },
  'bureau.workflows.get': {
    mcpExposable: true,
  },
  'bureau.workflows.history': {
    mcpExposable: false,
  },
  'bureau.workflows.impact': {
    mcpExposable: false,
  },
  'bureau.workflows.internal.get': {
    mcpExposable: false,
  },
  'bureau.workflows.list': {
    mcpExposable: true,
  },
  'bureau.workflows.pause': {
    mcpExposable: false,
  },
  'bureau.workflows.resume': {
    mcpExposable: false,
  },
  'bureau.workflows.revisions': {
    mcpExposable: false,
  },
  'bureau.workflows.runs.cancel': {
    mcpExposable: false,
  },
  'bureau.workflows.runs.get': {
    mcpExposable: true,
  },
  'bureau.workflows.runs.history': {
    mcpExposable: false,
  },
  'bureau.workflows.runs.list': {
    mcpExposable: true,
  },
  'bureau.workflows.runs.retry': {
    mcpExposable: false,
  },
  'bureau.workflows.signal': {
    mcpExposable: false,
  },
  'bureau.workflows.start': {
    mcpExposable: false,
  },
  'bureau.workflows.triggers.retry': {
    mcpExposable: false,
  },
  'bureau.workflows.update': {
    mcpExposable: false,
  },
  'bureau.workflows.validate': {
    mcpExposable: true,
  },
  'operative.runs.events': {
    mcpExposable: false,
  },
  'weft.system.principal': {
    mcpExposable: false,
  },
} as const;
