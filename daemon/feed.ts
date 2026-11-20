import { kvGet, kvSet, type Db } from './db.ts';
import type { FeedMark } from './types.ts';

/*
 * The Feed tab's Done and Later. Each mark remembers which version of a post it was made on (its key), so when
 * something new happens on that job (a new question, more failed tries, checks going red) the mark stops applying
 * and the post comes back to the top as a repost. The posts themselves are worked out in the browser (web/src/feed.ts).
 */

const KEY = 'feed.marks';
/** Later brings a post back after this long, if nothing new happened on the job first. */
export const LATER_MS = 2 * 3600_000;
/** Marks on jobs this old are forgotten: their posts have long since left the feed. */
const KEEP_MS = 7 * 24 * 3600_000;

export const feedMarks = (db: Db): FeedMark[] => kvGet<FeedMark[]>(db, KEY, []);

/** Marks a post done or for later, or clears its mark (status null: Undo). */
export function markFeed(db: Db, id: string, key: string, status: 'done' | 'later' | null, now = Date.now()): FeedMark[] {
  const rest = feedMarks(db).filter((m) => m.id !== id && now - m.at < KEEP_MS);
  const next = status ? [...rest, { id, key, status, at: now, until: status === 'later' ? now + LATER_MS : null }] : rest;
  kvSet(db, KEY, next.slice(-1000));
  return next;
}
