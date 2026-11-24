export const CATALOG_OPERATION_BEHAVIORS = {
  "other.feed.watch": {
    "mcpExposable": false
  },
  "probe.jobs.audit": {
    "mcpExposable": false
  },
  "probe.jobs.cancel": {
    "mcpExposable": false,
    "behavior": {
      "kind": "command",
      "responseDisposition": "one-time"
    }
  },
  "probe.jobs.list": {
    "mcpExposable": false,
    "behavior": {
      "kind": "read",
      "key": [
        "filter"
      ],
      "pagination": {
        "items": "jobs",
        "cursorInput": "cursor",
        "nextCursor": "next",
        "total": "total",
        "cursorFilters": [
          "filter"
        ],
        "itemKey": [
          "tenant",
          "id"
        ]
      }
    }
  },
  "probe.jobs.watch": {
    "mcpExposable": false,
    "behavior": {
      "kind": "read",
      "cursor": "cursor"
    }
  },
  "probe.users.get": {
    "mcpExposable": false
  }
} as const;
