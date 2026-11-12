/** The words for one state of one view. */
export type ViewStateCopy = {
  readonly title: string;
  readonly description: string;
};

/** The words for a view's empty state, and where to go from there. */
export type ViewEmptyCopy = ViewStateCopy & {
  readonly action?: { readonly label: string; readonly href: string };
};

/** The words for a view's forbidden page: its title, and the scope that opens it when it is known. */
export type ViewForbiddenCopy = {
  readonly title: string;
  readonly requirement?: string;
};

/** A link to a page of the application, with the words on it. */
export type ViewLink = { readonly label: string; readonly href: string };

/**
 * The words for a view's not-found page. A view whose missing thing has a natural next step names
 * it: `create` is a primary button that starts the thing again, and `back` the way back to the list
 * in the view's own words ("Back to chats"). Without them the page is the shared one: two secondary
 * buttons, back to the view's list and Search everything.
 */
export type ViewNotFoundCopy = ViewStateCopy & {
  readonly create?: ViewLink;
  readonly back?: ViewLink;
  /** Leaves out the "Search everything" button, for a page whose only way out is back to its list. */
  readonly searchHidden?: boolean;
};

export type ViewCopy = {
  /** The name of the view in navigation and headings. */
  readonly label: string;
  readonly loading: ViewStateCopy;
  /** Absent for a view that is never empty (`views.ts`, `canBeEmpty`). */
  readonly empty?: ViewEmptyCopy;
  readonly error: ViewStateCopy;
  /**
   * The words for a locked view: the title ("Your sign-in can’t open Hooks") and, when the missing
   * scope is known, the scope that opens it, which the page shows small and monospaced as
   * "requires bureau.hooks:read".
   */
  readonly forbidden: ViewForbiddenCopy;
  /** Present only for a view that opens one item by its address. */
  readonly notFound?: ViewNotFoundCopy;
  /** The words for a route of the view whose missing thing is not the one `notFound` names. */
  readonly notFoundByPattern?: Readonly<Record<string, ViewNotFoundCopy>>;
  /** The words for a route of the view whose nothing is not the one `empty` names. */
  readonly emptyByPattern?: Readonly<Record<string, ViewEmptyCopy>>;
  /** The words for a route of the view whose loading is not the one `loading` names. */
  readonly loadingByPattern?: Readonly<Record<string, ViewStateCopy>>;
  /** The words for a route of the view whose failure is not the one `error` names. */
  readonly errorByPattern?: Readonly<Record<string, ViewStateCopy>>;
  /**
   * The words for a route of the view whose lock is not a scope the principal lacks: the server
   * said no, and says in these words why.
   */
  readonly forbiddenByPattern?: Readonly<Record<string, ViewForbiddenCopy>>;
  /**
   * The page heading the frame keeps above its loading and failed states, for a view whose page
   * has a header of its own, so a person sees which page is loading or failed.
   */
  readonly header?: string;
  /** The heading for a route of the view whose heading is not the one `header` names. */
  readonly headerByPattern?: Readonly<Record<string, string>>;
};

/**
 * What the application says when the server does not answer: the title a turned-off control shows,
 * and the page that replaces a view with nothing to show. The banner's own words come from Cinder's
 * `offline`, `unreachable` and `stopped` presets, so no page words them differently.
 */
export const CONNECTION_COPY = {
  /**
   * The reason a control that changes something is off while the server is unreachable: its title,
   * and the visible text beside a composer's Send.
   */
  changesOff: 'Off until it’s back',
  /** The page of a view that has nothing to show because its first request got no answer. */
  page: {
    title: 'Server unreachable',
    description: 'The server did not answer. Check that Interborough is running, then try again.',
  },
} as const;

/** What precedes the age of the data a view keeps showing after its own request failed. */
export const STALE_DATA_LABEL = 'Showing data from';

/** The label on the control that asks a view to try again. */
export const RETRY_LABEL = 'Try again';

/**
 * What a route says when its code could not be loaded, such as after a rebuild replaced the files
 * an open page still points at. No view is involved, so it is not one of the view states.
 */
export const ROUTE_LOAD_FAILURE_COPY = {
  title: 'This page could not be loaded',
  description:
    'The application could not fetch the code for this page. It may have been rebuilt since you opened it.',
  action: 'Reload the page',
} as const;

/**
 * The words every not-found page shares (design rows 12x and 12y): the sentence under the title,
 * the breadcrumb that replaces the missing thing's name, and the two secondary buttons. The title
 * names the thing ("This run doesn’t exist") and is each view's own.
 */
export const NOT_FOUND_COPY = {
  description: 'It may have been deleted. The address might also be mistyped.',
  /** The last part of the breadcrumb, in words: Runs › Not found. */
  breadcrumb: 'Not found',
  /** The name of the button that returns to the list the missing thing belonged to. */
  back: (label: string): string => `Back to ${label}`,
  search: 'Search everything',
} as const;

/**
 * The words for an address no route matches. It is not one of a view's states: no view owns the
 * address, so the outlet shows this in its own frame (`data-view="not-found"`), and it leads back
 * to Home.
 */
export const NOT_FOUND_ROUTE_COPY = {
  title: 'This page doesn’t exist',
  description: NOT_FOUND_COPY.description,
} as const;

/**
 * The words every forbidden page shares (design rows 12z and 13a): the sentence under the title,
 * which points at the page that shows what the session may do, and the two secondary buttons.
 * There is no request-access button, because single-user v1 has no such flow.
 */
export const FORBIDDEN_COPY = {
  /** The title of a view that is locked: "Your sign-in can’t open Hooks". */
  title: (label: string): string => `Your sign-in can’t open ${label}`,
  description: 'Settings › API reference › Your scopes shows what it can do.',
  scopes: { label: 'See your scopes', href: '/settings/api-reference?group=scopes' },
  home: 'Back to Home',
} as const;

/**
 * What a write that named the revision, or the hash, it had read says when the thing had changed
 * since: nothing was written, and the page has read it again. The schedules and the goals say it.
 */
export const STALE_COPY = {
  title: (id: string): string => `“${id}” changed since you loaded it`,
  description:
    'Someone or something changed it after this page read it, so nothing was changed. It has been reloaded, and what you see is what it is now. Try again if you still want to.',
} as const;
