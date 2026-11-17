/**
 * Viewport width below which Sidebar uses its mobile drawer behavior: phones
 * get the drawer, while tablets (640px to 1023px) keep the inline column and
 * its collapsed icon rail.
 *
 * Consumers with app chrome outside the Sidebar can import this value instead
 * of duplicating the component's internal breakpoint.
 */
export const SIDEBAR_MOBILE_BREAKPOINT = '639.98px';

/**
 * Fully parenthesized media query used by Sidebar to switch from the inline
 * aside to the mobile drawer.
 */
export const SIDEBAR_MOBILE_MEDIA_QUERY = `(max-width: ${SIDEBAR_MOBILE_BREAKPOINT})`;
