import type { Db, Row } from './db.ts';
import { ghGraphql, listAccountsCached, tokenFor } from './github.ts';
import type { BoardPr, ChecksState, PrBoard, PrColumn, PrProblem } from './types.ts';

/*
 * The PRs tab: every PR your gh logins opened, plus any a Swarmville agent opened, sorted into columns by
 * what GitHub says about them. Nothing here is stored; the board is rebuilt from GitHub every few minutes.
 */

export const MERGED_DAYS = 7;

type Facts = { draft: boolean; merged: boolean; checks: ChecksState | null; conflicts: boolean; review: string | null };

/** Which column a PR sits in, and the one problem its card names (failing checks, conflicts, or changes asked). */
export function prColumn(f: Facts): { column: PrColumn; problem: PrProblem | null } {
  if (f.merged) return { column: 'merged', problem: null };
  const problem: PrProblem | null = f.checks === 'failing' ? 'checks' : f.conflicts ? 'conflicts' : f.review === 'CHANGES_REQUESTED' ? 'changes' : null;
  if (f.draft) return { column: 'draft', problem };
  if (problem) return { column: 'fix', problem };
  if (f.review === 'REVIEW_REQUIRED' || f.checks === 'pending') return { column: 'review', problem: null };
  return { column: 'ready', problem: null };
}

const KINDS = 'feat|fix|chore|docs|refactor|test|tests|perf|build|ci|style|revert|kb';
/**
 * "feat(slack): readable chat threads" → "Readable chat threads". The repo and column already say the rest.
 * Only a commit-style prefix goes: a known kind, or any word with a (scope). "Header: move…" keeps its "Header:".
 */
export function cleanTitle(t: string): string {
  const s = t.replace(new RegExp(`^\\s*(?:(?:${KINDS})(?:\\([^)]*\\))?|\\w+\\([^)]*\\))!?:\\s*`, 'i'), '').trim() || t.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** GitHub's rollup of a commit's checks, in Swarmville's words. */
export function rollupChecks(state: string | null | undefined): ChecksState {
  if (state === 'SUCCESS') return 'passing';
  if (state === 'FAILURE' || state === 'ERROR') return 'failing';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return 'none';
}

const FIELDS = `fragment F on PullRequest { url number title isDraft updatedAt mergedAt state reviewDecision mergeable
  repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;

/** Turns one GitHub PR node into a card. Null for a closed-without-merging PR or one merged too long ago. */
export function toBoardPr(n: any, sessionId: string | null, now: number): BoardPr | null {
  if (!n?.url || !n.repository) return null;
  const mergedAt = n.mergedAt ? Date.parse(n.mergedAt) : null;
  if (n.state === 'CLOSED' && !mergedAt) return null;
  if (mergedAt && now - mergedAt > MERGED_DAYS * 86400_000) return null;
  const checks = mergedAt ? null : rollupChecks(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state);
  const { column, problem } = prColumn({ draft: !!n.isDraft, merged: !!mergedAt, checks, conflicts: n.mergeable === 'CONFLICTING', review: n.reviewDecision ?? null });
  return {
    url: n.url, repo: n.repository.nameWithOwner, number: n.number, title: cleanTitle(String(n.title ?? '')), column, problem,
    checks, review: n.reviewDecision === 'APPROVED' ? 'approved' : n.reviewDecision === 'REVIEW_REQUIRED' ? 'needed' : n.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : null,
    updatedAt: Date.parse(n.mergedAt ?? n.updatedAt) || now, mergedAt, sessionId,
  };
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Asks GitHub for the board. One query per gh login, plus one to fill in agents' PRs no login authored. */
export async function fetchBoard(db: Db, now = Date.now()): Promise<PrBoard> {
  const since = day(now - MERGED_DAYS * 86400_000);
  // Agents' PRs: still open, or merged within the week. The newest job on each PR owns the card.
  const rows = db.prepare(`SELECT id, pr_url FROM sessions WHERE pr_url IS NOT NULL
      AND (COALESCE(pr_state, 'open') = 'open' OR COALESCE(pr_merged_at, 0) > ?) ORDER BY last_event_at DESC`).all(now - MERGED_DAYS * 86400_000) as Row[];
  const owner = new Map<string, string>();
  for (const r of rows) { const u = normUrl(r.pr_url); if (u && !owner.has(u)) owner.set(u, r.id); }
  const sessionFor = (url: string) => owner.get(normUrl(url) ?? '') ?? null;

  const found = new Map<string, BoardPr>();
  const errors: string[] = [];
  const logins = listAccountsCached();
  const add = (n: any) => { const p = n && toBoardPr(n, sessionFor(n.url), now); if (p) found.set(normUrl(p.url)!, p); };
  for (const login of logins) {
    const token = tokenFor(login);
    if (!token) { errors.push(`No token for ${login} from gh`); continue; }
    try {
      const r = await ghGraphql(token, `query($open: String!, $merged: String!) {
          open: search(query: $open, type: ISSUE, first: 60) { nodes { ...F } }
          merged: search(query: $merged, type: ISSUE, first: 40) { nodes { ...F } } } ${FIELDS}`,
        { open: `is:pr is:open archived:false author:${login}`, merged: `is:pr is:merged author:${login} merged:>=${since}` });
      for (const n of [...(r?.data?.open?.nodes ?? []), ...(r?.data?.merged?.nodes ?? [])]) add(n);
      if (!r?.data) errors.push(`GitHub didn't answer for ${login}`);
    } catch (e: any) { errors.push(`${login}: ${e?.message ?? e}`); }
  }
  // PRs an agent opened under a login gh isn't signed into: look each up by its link, with whichever login can see it.
  let missing = [...owner.keys()].filter((u) => !found.has(u)).slice(0, 30);
  for (const login of logins) {
    if (!missing.length) break;
    const token = tokenFor(login);
    if (!token) continue;
    try {
      const q = missing.map((u, i) => `p${i}: resource(url: ${JSON.stringify(u)}) { ...F }`).join('\n');
      const r = await ghGraphql(token, `query { ${q} } ${FIELDS}`);
      missing.forEach((_, i) => add(r?.data?.[`p${i}`]));
      missing = missing.filter((u) => !found.has(u));
    } catch {}
  }
  const prs = [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return { syncedAt: now, prs, errors: logins.length ? errors : ['Sign in to GitHub with `gh auth login` to see your PRs here.'] };
}

/** https://github.com/Owner/Repo/pull/12/files → https://github.com/owner/repo/pull/12, so links from agents and GitHub match. */
export function normUrl(u: string | null | undefined): string | null {
  const m = String(u ?? '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  return m ? `https://github.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}/pull/${m[3]}` : null;
}

export const readyCount = (b: PrBoard | null) => b?.prs.filter((p) => p.column === 'ready').length ?? 0;
