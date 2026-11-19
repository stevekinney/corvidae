import { expect } from 'bun:test';

import type { FetchLike } from './linear.ts';

export const SECRET = 'lin_api_test_secret_value';

interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  updatedAt: string;
  stateId: string;
  teamId: string;
  labelIds: string[];
  projectId: string | null;
  priority?: number;
}

interface FakeComment {
  id: string;
  issueId: string;
  body: string;
  createdAt: string;
  /** The author; the fake's API key belongs to `user-me`. */
  userId?: string;
}

/** A tiny in-memory Linear. Switches inject the ways a write can silently not take. */
export function fakeLinear() {
  const teams = [
    { id: 'team-cor', key: 'COR', parent: { id: 'team-eng' } },
    { id: 'team-eng', key: 'ENG', parent: null },
  ];
  const states = [
    { id: 's-todo', name: 'Todo', type: 'unstarted', team: { id: 'team-eng' } },
    { id: 's-doing', name: 'In Progress', type: 'started', team: { id: 'team-eng' } },
    { id: 's-done', name: 'Done', type: 'completed', team: { id: 'team-cor' } },
    { id: 's-canceled', name: 'Canceled', type: 'canceled', team: { id: 'team-eng' } },
  ];
  const labels = [
    { id: 'l-feature', name: 'Feature', team: { id: 'team-eng' } },
    { id: 'l-bug', name: 'Bug', team: { id: 'team-other' } },
  ];
  const issues: FakeIssue[] = [
    {
      id: 'uuid-1',
      identifier: 'COR-1',
      title: 'First',
      description: 'Original body',
      updatedAt: '2026-10-22T10:00:00Z',
      stateId: 's-todo',
      teamId: 'team-cor',
      labelIds: [],
      projectId: 'proj-1',
    },
    {
      id: 'uuid-2',
      identifier: 'COR-2',
      title: 'Second',
      description: '',
      updatedAt: '2026-10-22T10:00:00Z',
      stateId: 's-todo',
      teamId: 'team-cor',
      labelIds: [],
      projectId: null,
    },
  ];
  const comments: FakeComment[] = [];
  const projectStatuses = [
    { id: 'ps-backlog', name: 'Backlog' },
    { id: 'ps-doing', name: 'In Progress' },
    { id: 'ps-done', name: 'Completed' },
  ];
  const projects = [
    {
      id: 'proj-1',
      slugId: 'slug-one',
      name: 'Alpha',
      statusId: 'ps-backlog',
      updateIds: [] as string[],
    },
    {
      id: 'proj-2',
      slugId: 'slug-two',
      name: 'Beta',
      statusId: 'ps-doing',
      updateIds: [] as string[],
    },
    {
      id: 'proj-3',
      slugId: 'slug-three',
      name: 'Beta',
      statusId: 'ps-doing',
      updateIds: [] as string[],
    },
  ];
  const projectUpdates: {
    id: string;
    projectId: string;
    health: string;
    body: string;
    createdAt: string;
  }[] = [];
  /** State types of the issues in `proj-1`, in addition to COR-1 (unstarted). */
  const extraProjectIssueTypes: string[] = [];
  const relations: { type: string; issueId: string; relatedIssueId: string }[] = [];
  const log: {
    operation: string;
    variables: Record<string, unknown>;
    authorization: string | null;
  }[] = [];
  const switches = {
    ignoreStateUpdate: false,
    mangleComment: false,
    dropRelation: false,
    ignoreDescription: false,
    /** Linear reformats a comment the way it reformats a description. */
    reformatComment: false,
    /** Linear echoes a created description with `--` table rules and `*` bullets. */
    normalizeCreated: false,
    /** Linear echoes a created description with one word changed. */
    alterCreatedWord: false,
    /** More comments than the pages the reader will walk. */
    endlessComments: false,
    /** More relations than one page holds, in either direction. */
    pagedRelations: false,
    /** `projectUpdate` answers success without changing the status. */
    ignoreProjectStatus: false,
    /** A created project update comes back with a changed body. */
    mangleProjectUpdate: false,
    /** A created project update comes back with another health. */
    changeProjectHealth: false,
    /** More issues, projects or statuses than the pages the reader will walk. */
    endlessProjectPages: false,
    /** Another run's newer claim lands right after this run's claim comment is posted. */
    raceClaim: false,
    /** The provider replaces a lease marker after admission but before its mutation reread. */
    raceLeaseIdentity: false,
    /** `issueUpdate` answers success without changing the priority or the labels. */
    ignoreTriageUpdate: false,
  };
  let counter = 100;

  const view = (issue: FakeIssue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    updatedAt: issue.updatedAt,
    state: states.find((state) => state.id === issue.stateId),
    team: teams.find((team) => team.id === issue.teamId),
    labels: { nodes: issue.labelIds.map((id) => ({ id })) },
    project: issue.projectId === null ? null : { id: issue.projectId },
  });
  const find = (id: unknown) => issues.find((issue) => issue.id === id || issue.identifier === id);
  const brief = (issue: FakeIssue) => ({
    identifier: issue.identifier,
    title: issue.title,
    state: states.find((state) => state.id === issue.stateId),
  });

  const pageInfo = (hasNextPage = switches.endlessProjectPages, endCursor = 'more') => ({
    hasNextPage,
    endCursor: hasNextPage ? endCursor : null,
  });

  function handle(operation: string, variables: Record<string, any>): unknown {
    switch (operation) {
      case 'IssueRead': {
        const issue = find(variables['id']);
        return { issue: issue === undefined ? null : view(issue) };
      }
      case 'IssueComments': {
        const issue = find(variables['id']);
        if (issue === undefined) return { issue: null };
        // Newest first, the opposite of the order the code must impose.
        const nodes = comments.filter((comment) => comment.issueId === issue.id).toReversed();
        return {
          issue: {
            comments: {
              nodes,
              pageInfo: {
                hasNextPage: switches.endlessComments,
                endCursor: switches.endlessComments ? 'more' : null,
              },
            },
          },
        };
      }
      case 'TeamStates': {
        const ids: string[] = variables['filter'].team.id.in;
        return {
          workflowStates: {
            nodes: states.filter((state) => ids.includes(state.team.id)),
          },
        };
      }
      case 'IssueSetState': {
        const issue = find(variables['id'])!;
        if (!switches.ignoreStateUpdate) issue.stateId = variables['stateId'];
        return { issueUpdate: { success: true } };
      }
      case 'CommentPost': {
        const comment = {
          id: `c-${(counter += 1)}`,
          issueId: variables['issueId'],
          body: switches.mangleComment
            ? `${variables['body']}!!`
            : switches.reformatComment
              ? String(variables['body']).replace(/^\* /gm, '- ').replace(/_/g, '\\_')
              : variables['body'],
          createdAt: `2026-10-22T11:${String(comments.length).padStart(2, '0')}:00Z`,
        };
        comments.push(comment);
        if (switches.raceClaim && String(comment.body).startsWith('Claim:'))
          comments.push({
            id: `c-${(counter += 1)}`,
            issueId: comment.issueId,
            body: 'Claim: run other-run, branch other, since 2026-10-22T11:59:00Z, checkpoint 2026-10-22T11:59:00Z, head none, status held',
            createdAt: '2026-10-22T11:59:30Z',
          });
        return {
          commentCreate: { success: true, comment: { id: comment.id } },
        };
      }
      case 'CommentRead': {
        const comment = comments.find((candidate) => candidate.id === variables['id']);
        if (comment === undefined) return { comment: null };
        return {
          comment: {
            id: comment.id,
            body: comment.body,
            issue: { identifier: find(comment.issueId)!.identifier },
          },
        };
      }
      case 'CommentOwner': {
        const comment = comments.find((candidate) => candidate.id === variables['id']);
        return {
          viewer: { id: 'user-me' },
          comment:
            comment === undefined
              ? null
              : {
                  id: comment.id,
                  user: { id: comment.userId ?? 'user-me' },
                  issue: { identifier: find(comment.issueId)!.identifier },
                },
        };
      }
      case 'CommentUpdate': {
        const comment = comments.find((candidate) => candidate.id === variables['id'])!;
        comment.body = switches.mangleComment ? `${variables['body']}!!` : variables['body'];
        return { commentUpdate: { success: true } };
      }
      case 'IssueSetDescription': {
        const issue = find(variables['id'])!;
        // Linear escapes punctuation and rewrites bullets.
        if (!switches.ignoreDescription)
          issue.description = String(variables['description'])
            .replace(/^\* /gm, '- ')
            .replace(/_/g, '\\_');
        return { issueUpdate: { success: true } };
      }
      case 'TeamByKey': {
        const team = teams.find((candidate) => candidate.key === variables['filter'].key.eq);
        return { teams: { nodes: team === undefined ? [] : [team] } };
      }
      case 'DuplicateTitle': {
        const filter = variables['filter'];
        const nodes = issues.filter(
          (issue) =>
            issue.title.toLowerCase() === filter.title.eqIgnoreCase.toLowerCase() &&
            (filter.project === undefined
              ? issue.teamId === filter.team.id.eq
              : issue.projectId === filter.project.id.eq),
        );
        return {
          issues: {
            nodes: nodes.map((issue) => ({
              identifier: issue.identifier,
              title: issue.title,
            })),
          },
        };
      }
      case 'LabelByName':
        return {
          issueLabels: {
            nodes: labels.filter(
              (label) =>
                label.name.toLowerCase() === variables['filter'].name.eqIgnoreCase.toLowerCase(),
            ),
          },
        };
      case 'IssueMake': {
        const input = variables['input'];
        const issue: FakeIssue = {
          id: `uuid-${(counter += 1)}`,
          identifier: `COR-${counter}`,
          title: input.title,
          description: switches.normalizeCreated
            ? String(input.description)
                .replace(/-{3,}/g, '--')
                .replace(/^- /gm, '* ')
                .replace(switches.alterCreatedWord ? 'one' : '\0', 'uno')
            : input.description,
          updatedAt: '2026-10-22T12:00:00Z',
          stateId: input.stateId ?? 's-todo',
          teamId: input.teamId,
          labelIds: input.labelIds,
          projectId: input.projectId ?? null,
        };
        issues.push(issue);
        return {
          issueCreate: {
            success: true,
            issue: { id: issue.id, identifier: issue.identifier },
          },
        };
      }
      case 'IssueSetPriority': {
        const issue = find(variables['id'])!;
        if (!switches.ignoreTriageUpdate) issue.priority = variables['priority'];
        return { issueUpdate: { success: true } };
      }
      case 'IssuePriority':
        return { issue: { priority: find(variables['id'])?.priority ?? 0 } };
      case 'TeamLabels':
        return {
          issueLabels: {
            nodes: [
              ...labels.map((label) => ({ ...label, isGroup: false, parent: null })),
              { id: 'l-group', name: 'Work Type', team: null, isGroup: true, parent: null },
              {
                id: 'l-chore',
                name: 'Chore',
                team: null,
                isGroup: false,
                parent: { id: 'l-group', name: 'Work Type' },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'IssueAddLabels': {
        const issue = find(variables['id'])!;
        if (!switches.ignoreTriageUpdate)
          issue.labelIds = [...new Set([...issue.labelIds, ...variables['labelIds']])];
        return { issueUpdate: { success: true } };
      }
      case 'IssueLabels': {
        const issue = find(variables['id']);
        return { issue: issue === undefined ? null : { labels: view(issue).labels } };
      }
      case 'IssueCreated': {
        const issue = find(variables['id']);
        return { issue: issue === undefined ? null : view(issue) };
      }
      case 'IssueRelations': {
        const issue = find(variables['id']);
        if (issue === undefined) return { issue: null };
        return {
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            relations: {
              nodes: relations
                .filter((relation) => relation.issueId === issue.id)
                .map((relation) => ({
                  type: relation.type,
                  relatedIssue: brief(find(relation.relatedIssueId)!),
                })),
              pageInfo: { hasNextPage: switches.pagedRelations },
            },
            inverseRelations: {
              nodes: relations
                .filter((relation) => relation.relatedIssueId === issue.id)
                .map((relation) => ({
                  type: relation.type,
                  issue: brief(find(relation.issueId)!),
                })),
              pageInfo: { hasNextPage: false },
            },
          },
        };
      }
      case 'RelationMake': {
        if (!switches.dropRelation) relations.push(variables['input']);
        return { issueRelationCreate: { success: true } };
      }
      case 'ProjectList':
        return {
          projects: {
            nodes: projects.map(({ id, name, slugId }) => ({ id, name, slugId })),
            pageInfo: pageInfo(),
          },
        };
      case 'ProjectRead': {
        const project = projects.find((candidate) => candidate.id === variables['id']);
        if (project === undefined) return { project: null };
        const latest = projectUpdates.filter((update) => update.projectId === project.id).at(-1);
        if (switches.raceLeaseIdentity && latest !== undefined) {
          switches.raceLeaseIdentity = false;
          latest.body = latest.body
            .replace(/operation \S+/, 'operation replaced-operation')
            .replace(
              /intent [a-f0-9]{64}/,
              'intent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            );
        }
        return {
          project: {
            id: project.id,
            name: project.name,
            slugId: project.slugId,
            status: projectStatuses.find((status) => status.id === project.statusId) ?? null,
            lastUpdate: latest === undefined ? null : { id: latest.id, health: latest.health },
          },
        };
      }
      case 'ProjectIssues': {
        const project = projects.find((candidate) => candidate.id === variables['id']);
        if (project === undefined) return { project: null };
        const nodes = [
          ...issues
            .filter((issue) => issue.projectId === project.id)
            .map((issue) => ({
              state: { type: states.find((s) => s.id === issue.stateId)!.type },
            })),
          ...(project.id === 'proj-1'
            ? extraProjectIssueTypes.map((type) => ({ state: { type } }))
            : []),
        ];
        // Two issues per page, so a count has to follow the cursor.
        const start = variables['after'] === null ? 0 : Number(variables['after']);
        const end = start + 2;
        return {
          project: {
            issues: {
              nodes: nodes.slice(start, end),
              pageInfo: pageInfo(end < nodes.length || switches.endlessProjectPages, String(end)),
            },
          },
        };
      }
      case 'ProjectStatuses':
        return { projectStatuses: { nodes: projectStatuses, pageInfo: pageInfo() } };
      case 'ProjectSetStatus': {
        const project = projects.find((candidate) => candidate.id === variables['id'])!;
        if (!switches.ignoreProjectStatus) project.statusId = variables['statusId'];
        return { projectUpdate: { success: true } };
      }
      case 'ProjectUpdateMake': {
        const input = variables['input'];
        const update = {
          id: `pu-${(counter += 1)}`,
          projectId: input.projectId,
          health: switches.changeProjectHealth ? 'offTrack' : input.health,
          body: switches.mangleProjectUpdate
            ? `${input.body}!!`
            : String(input.body).replace(/^\* /gm, '- ').replace(/_/g, '\\_'),
          createdAt: `2026-11-09T10:${String(projectUpdates.length).padStart(2, '0')}:00Z`,
        };
        projectUpdates.push(update);
        return { projectUpdateCreate: { success: true, projectUpdate: { id: update.id } } };
      }
      case 'ProjectUpdates': {
        const project = projects.find((candidate) => candidate.id === variables['id']);
        if (project === undefined) return { project: null };
        return {
          project: {
            projectUpdates: {
              // Oldest first, the opposite of the order the code must impose.
              nodes: projectUpdates
                .filter((update) => update.projectId === project.id)
                .map(({ id, body, createdAt }) => ({ id, body, createdAt })),
              pageInfo: pageInfo(),
            },
          },
        };
      }
      case 'ProjectUpdateRead': {
        const update = projectUpdates.find((candidate) => candidate.id === variables['id']);
        return {
          projectUpdate:
            update === undefined
              ? null
              : {
                  id: update.id,
                  body: update.body,
                  health: update.health,
                  project: { id: update.projectId },
                },
        };
      }
      default:
        throw new Error(`fake Linear: unhandled operation ${operation}`);
    }
  }

  const fetchLike: FetchLike = async (url, init) => {
    expect(url).toBe('https://api.linear.app/graphql');
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = /(?:query|mutation) (\w+)/.exec(body.query)![1]!;
    const headers = init.headers as Record<string, string>;
    log.push({
      operation,
      variables: body.variables,
      authorization: headers['authorization'] ?? null,
    });
    try {
      return Response.json({ data: handle(operation, body.variables) });
    } catch (error) {
      if (String(error).includes('fake Linear')) throw error;
      return Response.json({ errors: [{ message: String(error) }] });
    }
  };
  return {
    fetch: fetchLike,
    issues,
    comments,
    relations,
    log,
    switches,
    states,
    projects,
    projectUpdates,
    extraProjectIssueTypes,
  };
}
