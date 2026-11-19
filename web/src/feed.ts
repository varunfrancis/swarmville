import type { FeedMark, SessionView } from '../../daemon/types.ts';
import { chatTask, firstLine } from './chats.ts';
import { plainAction } from './copy.ts';

/*
 * The Feed tab: one post per job, like a social feed you clear. A post says where the job stands (a chip), what the
 * agent said (in plain words once the small model has rewritten it; the agent's own words stay one tap away), and the
 * buttons that move it on. Done and Later clear it; when something new happens on the job it comes back as a repost.
 * Pure functions, so the rules are easy to test. Agents at work don't post until they finish, ask or get stuck.
 */

export type PostKind = 'question' | 'plan' | 'permission' | 'asked' | 'stuck' | 'failing' | 'ready' | 'working' | 'shipped' | 'finished';
export type Chip = 'wait' | 'plan' | 'stuck' | 'ready' | 'run' | 'shipped' | 'finished';
export const CHIP: Record<PostKind, Chip> = {
  question: 'wait', permission: 'wait', asked: 'wait', plan: 'plan', stuck: 'stuck', failing: 'stuck', ready: 'ready', working: 'run', shipped: 'shipped', finished: 'finished',
};
export const CHIP_LABEL: Record<Chip, string> = {
  wait: 'Waiting on you', plan: 'Plan ready', stuck: 'Stuck', ready: 'Ready to merge', run: 'Working', shipped: 'Shipped', finished: 'Finished',
};
/** Kinds that wait on you: they count in the tab's badge and sit above the rest. */
export const WAITING = new Set<PostKind>(['question', 'plan', 'permission', 'asked', 'stuck', 'failing', 'ready']);

type S = SessionView & { projectName?: string };
export type FeedPost = {
  id: string; s: S; kind: PostKind; key: string; at: number;
  task: string; text: string;
  /** The agent's own words, when the text is a rewrite of them. */
  own: string | null;
  /** Why it came back to the top, when it's a repost. */
  repost: string | null;
  /** Your Done / Later on this version of the post. */
  mark: FeedMark | null;
};

const H = 3600_000;
/** Waiting posts stay up for days (a review can sit a while); news drops off after a day. */
const WAIT_WINDOW = 3 * 24 * H;
const NEWS_WINDOW = 24 * H;
/** Done or Later just now: the post stays as a thin row with Undo for this long. */
export const UNDO_MS = 5 * 60_000;

const lastAt = (s: S) => s.lastEventAt ?? s.endedAt ?? s.startedAt ?? 0;
const prOpen = (s: S) => !!s.prUrl && s.prState !== 'merged' && s.prState !== 'closed';

/** What kind of post a job makes right now, or null when it makes none (at work on its first turn, a payment, nothing said). */
export function postKind(s: S): PostKind | null {
  if (s.status === 'needs_input') {
    if (s.payment && !s.ask) return null; // the Wallet answers payments
    if (s.ask?.questions?.length) return 'question';
    if (s.ask?.tool === 'ExitPlanMode') return 'plan';
    if (s.ask) return 'permission';
    return 'asked';
  }
  if (s.stuck) return 'stuck';
  if (prOpen(s) && s.prChecks === 'failing') return 'failing';
  if (s.status === 'running') return s.outcome ? 'working' : null;
  if (prOpen(s) && (s.prChecks === 'passing' || s.prChecks === 'none')) return 'ready';
  // still open and their last word was a question: it's your turn
  if (s.status === 'idle' && !s.away && endsAsking(s.plainOutcome ?? s.outcome)) return 'asked';
  if (s.prState === 'merged' || s.stamp === 'shipped') return 'shipped';
  return s.outcome ? 'finished' : null;
}

/** Their message ends by asking you something. */
export const endsAsking = (t: string | null | undefined) => !!t && /\?["')\]*]*\s*$/.test(t.trim());

/** A short fingerprint, so a mark is tied to what the post said when you cleared it. */
export function hash(t: string | null | undefined): string {
  let h = 0;
  for (const c of t ?? '') h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

/** The version of a post. A new question, another failed try, red checks or a new reply each make a new one. */
export function postKey(s: S, kind: PostKind): string {
  switch (kind) {
    case 'question': case 'plan': case 'permission': return `${kind}:${s.ask?.id ?? ''}`;
    case 'stuck': return `stuck:${s.stuck?.count ?? 0}`;
    case 'failing': case 'ready': return `${kind}:${s.prUrl}`;
    case 'working': return 'working';
    default: return `${kind}:${hash(s.outcome)}`;
  }
}

/** The post's words: the small model's rewrite when there is one, else the first line of what the agent said. */
export function postText(s: S, kind: PostKind): { text: string; own: string | null } {
  const said = s.plainOutcome ?? firstLine(s.outcome, 280);
  const own = s.outcome && s.outcome.trim() !== said ? s.outcome.trim() : null;
  switch (kind) {
    case 'question': return { text: s.ask!.questions![0].question, own: null };
    case 'plan': return { text: 'Here’s my plan. Approve it, or tell me what to change.', own: null };
    case 'permission': return { text: `Can I ${lowerFirst(s.ask!.title)}?`, own: null };
    case 'stuck': return { text: `I’m stuck: the same problem came back ${s.stuck!.count} times.`, own: s.stuck!.problem || null };
    case 'failing': return { text: 'The checks on my pull request are failing.', own };
    case 'working': {
      // "Using TaskStop" (a bare tool name) means nothing to most people
      const a = /^using \w+$/i.test(s.action ?? '') ? null : plainAction(s.action, 'plain');
      return { text: a ? `On it: ${a}` : 'On it.', own: null };
    }
    default: return { text: said ?? s.needsMessage ?? 'Waiting for your answer.', own };
  }
}
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** Why a post came back after you cleared it. */
export function repostReason(kind: PostKind, s: S): string {
  switch (kind) {
    case 'stuck': return `Reposted · still stuck after ${s.stuck?.count ?? 0} tries`;
    case 'failing': return 'Reposted · checks are failing';
    case 'ready': return 'Reposted · ready to merge now';
    case 'working': return 'Reposted · back at work';
    case 'shipped': case 'finished': return 'Reposted · new update';
    default: return 'Reposted · needs you again';
  }
}

export type FeedFilter = 'all' | 'waiting' | 'later' | 'done';

/**
 * Every post, newest first with the ones waiting on you on top. A mark made on an older version of the post no longer
 * applies, and the post comes back as a repost; Later comes back on its own once its time is up.
 */
export function feedPosts(sessions: S[], marks: FeedMark[], now: number): FeedPost[] {
  const byId = new Map(marks.map((m) => [m.id, m]));
  const out: FeedPost[] = [];
  for (const s of sessions) {
    const kind = postKind(s);
    if (!kind) continue;
    const waiting = WAITING.has(kind);
    if (now - lastAt(s) > (waiting ? WAIT_WINDOW : NEWS_WINDOW)) continue;
    if (s.scheduled && !waiting) continue; // scheduled jobs' routine results stay out of the feed
    const task = chatTask(s);
    if (!task && !s.prompts && kind !== 'question' && kind !== 'plan' && kind !== 'permission') continue;
    const key = postKey(s, kind);
    const m = byId.get(s.id) ?? null;
    const applies = !!m && m.key === key && !(m.status === 'later' && m.until != null && now >= m.until);
    const repost = m && !applies ? (m.key === key ? 'Back from Later' : repostReason(kind, s)) : null;
    const { text, own } = postText(s, kind);
    out.push({ id: s.id, s, kind, key, at: lastAt(s), task: task ?? 'New job', text, own, repost, mark: applies ? m : null });
  }
  return out.sort((a, b) => Number(WAITING.has(b.kind)) - Number(WAITING.has(a.kind)) || b.at - a.at);
}

/** Is this post in the list for a filter? In All, a post you just cleared stays as a thin row with Undo for a few minutes. */
export function inFilter(p: FeedPost, f: FeedFilter, now: number): boolean {
  if (f === 'all') return !p.mark || now - p.mark.at < UNDO_MS;
  if (f === 'waiting') return !p.mark && WAITING.has(p.kind);
  return p.mark?.status === f;
}

/** Waiting on you and not cleared: the Feed tab's badge. */
export const waitingCount = (posts: FeedPost[]) => posts.filter((p) => !p.mark && WAITING.has(p.kind)).length;

/** One-tap answers: a single question with a single choice. Anything else opens the full answer form. */
export function oneTap(s: Pick<SessionView, 'ask'>): { label: string; description: string }[] | null {
  const q = s.ask?.questions;
  return q?.length === 1 && !q[0].multiSelect && q[0].options.length ? q[0].options : null;
}
