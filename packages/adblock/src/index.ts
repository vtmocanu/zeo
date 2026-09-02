/**
 * Public surface of `@zeo/adblock`: the content-blocking wrapper, its factory
 * functions, and the event/option types they use.
 */
export type { BlockedEvent, Blocker, BlockerFs, CreateBlockerOptions } from "./blocker.js";
export { createBlocker, createBlockerFromFilters } from "./blocker.js";
