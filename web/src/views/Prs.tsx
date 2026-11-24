import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BoardPr, PrBoard, PrColumn, SessionView, StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { ago } from '../format.ts';
import { post, useNow } from '../useSwarmville.ts';
import { SavedToast } from '../SavedToast.tsx';

/*
 * The PRs tab: every PR you or your agents opened, on a board whose columns come from GitHub (no dragging).
 * Cards stay small on purpose: repo and number, the title, one chip only when something is wrong, who opened it,
 * and Merge when it's ready. Everything else is in the drawer a click away.
 */

const COLUMNS: { id: PrColumn; name: string }[] = [
  { id: 'draft', name: 'Draft' }, { id: 'fix', name: 'Needs fixing' }, { id: 'review', name: 'Waiting for review' },
  { id: 'ready', name: 'Ready to merge' }, { id: 'merged', name: 'Merged' },
];
const PROBLEM = { checks: 'Checks failing', conflicts: 'Conflicts', changes: 'Changes asked' } as const;

/** Why a PR sits where it does, in a sentence for the drawer. */
export function whyText(p: BoardPr, now = Date.now()): string {
  if (p.column === 'merged') return `Merged ${ago(p.mergedAt, now)}.`;
  const problem = p.problem === 'checks' ? 'Its checks are failing.'
    : p.problem === 'conflicts' ? 'Someone changed the same files on the main branch since, so it needs bringing up to date before it can merge.'
    : p.problem === 'changes' ? 'A reviewer asked for changes.' : '';
  if (p.column === 'draft') return `Marked draft on GitHub.${problem ? ` ${problem}` : ''}`;
  if (p.column === 'fix') return problem;
  if (p.column === 'review') return p.checks === 'pending' ? 'Its checks are still running.' : 'GitHub wants an approving review before it can merge.';
  return p.review === 'approved' ? 'Approved, checks pass and no conflicts.' : 'No approval needed, nothing failing and no conflicts.';
}

const short = (repo: string) => repo.split('/')[1] ?? repo;

export function Prs({ state, openChat }: { state: StateView; openChat: (sessionId: string) => void }) {
  const now = useNow(60_000);
  const [board, setBoard] = useState<PrBoard | null>(null);
  const [failed, setFailed] = useState(false);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ at: number; text: string } | null>(null);
  const load = useCallback(() => fetch('/api/prs').then((r) => r.json()).then((b: PrBoard) => { setBoard(b); setFailed(false); }).catch(() => setFailed(true)), []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  // The daemon re-reads GitHub every few minutes; its ready count moving means there's a new board to show.
  useEffect(() => { if (board) load(); }, [state.prsReady]);
  const sessions = useMemo(() => new Map(state.sessions.map((s) => [s.id, s])), [state.sessions]);
  const say = (text: string) => setToast({ at: Date.now(), text });

  const merge = async (p: BoardPr) => {
    setBusy(p.url);
    const r = await post('/api/prs/merge', { url: p.url }).catch(() => ({ ok: false, message: 'Couldn’t reach Swarmville.' }));
    setBusy(null);
    say(r.ok ? `Merged ${short(p.repo)} #${p.number}` : r.message ?? 'That didn’t merge.');
    if (r.ok) setOpenUrl(null);
    load();
  };
  const askFix = async (p: BoardPr, s: SessionView) => {
    const r = await post(`/api/ship/${encodeURIComponent(s.id)}/fix`).catch(() => ({ ok: false, message: 'Couldn’t reach Swarmville.' }));
    say(r.ok ? `Asked ${s.agent.name} to fix the checks` : r.message ?? 'That didn’t send.');
  };

  const prs = board?.prs ?? [];
  const open = prs.filter((p) => p.column !== 'merged');
  const ready = prs.filter((p) => p.column === 'ready').length;
  const repos = new Set(open.map((p) => p.repo)).size;
  const sel = openUrl ? prs.find((p) => p.url === openUrl) ?? null : null;

  return (
    <div className="prs">
      <div className="prs-head">
        <h1>PRs</h1>
        <span className="muted">{!board ? (failed ? 'Can’t reach Swarmville.' : 'Asking GitHub…')
          : `${open.length} open${repos > 1 ? ` across ${repos} repos` : ''}${ready ? ` · ${ready} ready to merge` : ''}`}</span>
      </div>
      {board?.errors.length ? <p className="prs-error">{board.errors.join(' ')}</p> : null}
      <div className="prs-board">
        {COLUMNS.map((c) => {
          const items = prs.filter((p) => p.column === c.id);
          return (
            <section key={c.id} className={`prs-col col-${c.id}`} aria-label={c.name}>
              <div className="prs-col-head"><span className="prs-dot" aria-hidden="true" /><h2>{c.name}</h2>{items.length ? <span className="prs-count">{items.length}</span> : null}</div>
              {items.length ? items.map((p) => (
                <Card key={p.url} p={p} s={p.sessionId ? sessions.get(p.sessionId) : undefined} now={now} busy={busy === p.url}
                  onOpen={() => setOpenUrl(p.url)} onMerge={() => merge(p)} />
              )) : <div className="prs-empty">{board ? 'Nothing here' : ''}</div>}
            </section>
          );
        })}
      </div>
      {sel ? <Drawer p={sel} s={sel.sessionId ? sessions.get(sel.sessionId) : undefined} now={now} busy={busy === sel.url}
        onClose={() => setOpenUrl(null)} onMerge={() => merge(sel)} onFix={askFix} openChat={openChat} /> : null}
      {toast ? <SavedToast key={toast.at} message={toast.text} onDone={() => setToast(null)} /> : null}
    </div>
  );
}

function Card({ p, s, now, busy, onOpen, onMerge }: { p: BoardPr; s?: SessionView; now: number; busy: boolean; onOpen: () => void; onMerge: () => void }) {
  return (
    <article className="prs-card" onClick={onOpen}>
      <button type="button" className="prs-card-open" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
        <span className="prs-repo">{short(p.repo)} #{p.number}</span>
        <span className="prs-title">{p.title}</span>
      </button>
      {p.problem ? <span className="prs-chip">{PROBLEM[p.problem]}</span> : null}
      <div className="prs-foot">
        {s ? <span className="prs-who"><AgentAvatar agent={s.agent} mood={moodFor(s)} size={22} />{s.agent.name}</span> : null}
        <span className="prs-ago">{ago(p.mergedAt ?? p.updatedAt, now)}</span>
        {p.column === 'ready' ? <button type="button" className="prs-merge" disabled={busy} onClick={(e) => { e.stopPropagation(); onMerge(); }}>{busy ? 'Merging…' : 'Merge'}</button> : null}
      </div>
    </article>
  );
}

function Drawer({ p, s, now, busy, onClose, onMerge, onFix, openChat }: {
  p: BoardPr; s?: SessionView; now: number; busy: boolean; onClose: () => void; onMerge: () => void; onFix: (p: BoardPr, s: SessionView) => void; openChat: (id: string) => void;
}) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    <aside className="panel prs-drawer" aria-label={`${short(p.repo)} #${p.number}`}>
      <header className="panel-head">
        <div>
          <div className="panel-sub">{p.repo} #{p.number}</div>
          <h2>{p.title}</h2>
        </div>
        <button className="ghost close" onClick={onClose} aria-label="Close">×</button>
      </header>
      <p className="prs-why">{whyText(p, now)}</p>
      {s ? (
        <button type="button" className="prs-agent" onClick={() => openChat(s.id)} title="Open in Chats">
          <AgentAvatar agent={s.agent} mood={moodFor(s)} size={34} /><span>Opened by <b>{s.agent.name}</b></span><span className="prs-agent-go">Open in Chats →</span>
        </button>
      ) : null}
      <div className="prs-acts">
        {p.column === 'ready' ? <button type="button" className="prs-merge" disabled={busy} onClick={onMerge}>{busy ? 'Merging…' : 'Merge'}</button> : null}
        {p.column === 'fix' && p.problem === 'checks' && s ? <button type="button" className="prs-fix" onClick={() => onFix(p, s)}>Ask {s.agent.name} to fix</button> : null}
        <a className="ghost prs-gh" href={p.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
      </div>
    </aside>
  );
}
