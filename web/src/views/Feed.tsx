import { useEffect, useMemo, useState } from 'react';
import type { ChatLine, ChatView, SessionView, StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { GoTo } from '../components.tsx';
import { ago } from '../format.ts';
import { post, useNow } from '../useSwarmville.ts';
import { AskBody, useAsk } from './AskPopup.tsx';
import { CHIP, CHIP_LABEL, feedPosts, inFilter, oneTap, waitingCount, type FeedFilter, type FeedPost } from '../feed.ts';

/*
 * The Feed tab: every job as a post you clear. Answer, approve or merge right on the post, reply in its box,
 * then Done or Later. "Open in Chats" has the whole conversation.
 */

const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'waiting', label: 'Waiting on you' }, { id: 'later', label: 'Later' }, { id: 'done', label: 'Done' },
];
const EMPTY: Record<FeedFilter, string> = {
  all: 'Nothing in your feed right now. Agents post here when they finish, ask you something, or get stuck.',
  waiting: 'Nobody is waiting on you.', later: 'Nothing snoozed.', done: 'Nothing cleared yet.',
};

export function Feed({ state, openChat }: { state: StateView; openChat: (sessionId: string) => void }) {
  const now = useNow(30_000);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [project, setProject] = useState<string | null>(null);
  const names = useMemo(() => new Map(state.projects.map((p) => [p.id, p.name])), [state.projects]);
  const posts = useMemo(() => feedPosts(state.sessions.map((s) => ({ ...s, projectName: names.get(s.projectId ?? '') })), state.feed ?? [], now),
    [state.sessions, state.feed, names, now]);
  const inProject = posts.filter((p) => !project || p.s.projectId === project);
  const shown = inProject.filter((p) => inFilter(p, filter, now));
  const count = (f: FeedFilter) => (f === 'all' ? inProject.filter((p) => !p.mark).length : inProject.filter((p) => inFilter(p, f, now)).length);
  const projects = useMemo(() => {
    const seen = new Map<string, SessionView>();
    for (const p of posts) if (p.s.projectId && !seen.has(p.s.projectId)) seen.set(p.s.projectId, p.s);
    return [...seen.entries()].map(([id, s]) => ({ id, name: names.get(id) ?? 'Other', s }));
  }, [posts, names]);
  const working = state.sessions.filter((s) => s.status === 'running' && (!project || s.projectId === project));
  const waiting = waitingCount(inProject);

  return (
    <div className="feed">
      <aside className="feed-rail" aria-label="Filter the feed">
        <div className="feed-label">Feed</div>
        {FILTERS.map((f) => {
          const n = count(f.id);
          return (
            <button key={f.id} type="button" className={`feed-filter${filter === f.id ? ' on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              <span>{f.label}</span>{n ? <span className={`feed-count${f.id === 'waiting' ? ' hot' : ''}`}>{n}</span> : null}
            </button>
          );
        })}
        {projects.length > 1 ? <>
          <div className="feed-label feed-label-gap">Projects</div>
          {projects.map((p) => (
            <button key={p.id} type="button" className={`feed-filter feed-proj${project === p.id ? ' on' : ''}`} aria-pressed={project === p.id} onClick={() => setProject(project === p.id ? null : p.id)}>
              <AgentAvatar agent={p.s.agent} mood={moodFor(p.s)} size={26} /><span className="feed-proj-name">{p.name}</span>
            </button>
          ))}
        </> : null}
      </aside>

      <section className="feed-main" aria-label="Posts">
        <div className="feed-head">
          <h1>{FILTERS.find((f) => f.id === filter)!.label === 'All' ? 'Feed' : FILTERS.find((f) => f.id === filter)!.label}</h1>
          <span className="muted">{project ? names.get(project) : waiting ? `${waiting} waiting on you` : 'All caught up'}</span>
        </div>
        {shown.length ? shown.map((p) => (
          p.mark && filter === 'all'
            ? <Cleared key={p.id} p={p} />
            : <Post key={`${p.id}:${p.key}`} p={p} openChat={openChat} wallet={state.wallet} version={state.generatedAt} />
        )) : <div className="feed-empty"><b>All clear</b><span>{EMPTY[filter]}</span></div>}
      </section>

      <aside className="feed-side" aria-label="Working now">
        <div className="feed-label">Working now</div>
        {working.length ? working.map((s) => (
          <button key={s.id} type="button" className="feed-working" onClick={() => openChat(s.id)} title="Open in Chats">
            <AgentAvatar agent={s.agent} mood={moodFor(s)} size={30} />
            <span className="feed-working-text"><b>{s.focus ?? s.title}</b><small>{names.get(s.projectId ?? '') ?? 'Other'}</small></span>
            <span className="feed-live" aria-hidden="true" />
          </button>
        )) : <p className="muted feed-note">Nobody is working right now.</p>}
        <p className="muted feed-note">Agents at work don’t post until they finish, ask you something, or get stuck, so the feed stays quiet.</p>
      </aside>
    </div>
  );
}

const mark = (p: FeedPost, status: 'done' | 'later' | null) => post('/api/feed/mark', { id: p.id, key: p.key, status });
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A post you just cleared, kept a few minutes so you can take it back. */
function Cleared({ p }: { p: FeedPost }) {
  return (
    <div className="feed-cleared">
      <AgentAvatar agent={p.s.agent} mood={moodFor(p.s)} size={26} />
      <span><b>{p.mark!.status === 'done' ? 'Done' : `Later, back at ${clock(p.mark!.until ?? p.mark!.at)}`}</b> · {p.task}</span>
      <button type="button" className="ghost small" onClick={() => mark(p, null)}>Undo</button>
    </div>
  );
}

function Post({ p, openChat, wallet, version }: { p: FeedPost; openChat: (id: string) => void; wallet: StateView['wallet']; version: number }) {
  const s = p.s;
  const chip = CHIP[p.kind];
  const [own, setOwn] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = useAsk(s);
  const options = p.kind === 'question' ? oneTap(s) : null;
  const acted = (msg: string | null | undefined) => { setSince(Date.now()); setSaid(msg ?? null); };
  const act = async (url: string, label: string) => {
    setBusy(true);
    const r = await post(url);
    setBusy(false);
    acted(r.message ?? (r.ok ? label : 'That didn’t work. Try again from Chats.'));
  };
  useEffect(() => { if (ask.done) acted(ask.done); }, [ask.done]);
  const showAsk = !ask.done && (p.kind === 'plan' || p.kind === 'permission' || (p.kind === 'question' && !options));

  return (
    <article className={`feed-post${chip === 'wait' || chip === 'plan' || chip === 'stuck' || chip === 'ready' ? ` hot c-${chip}` : ''}${p.mark ? ' cleared' : ''}`}>
      {p.repost ? <div className="feed-repost"><RepostIcon />{p.repost}</div> : null}
      <div className="feed-post-row">
        <AgentAvatar agent={s.agent} mood={moodFor(s)} size={44} />
        <div className="feed-post-body">
          <div className="feed-post-top">
            <div className="feed-post-title">
              <b>{p.task}</b>
              <small>{s.projectName ?? 'Other'} · {s.agent.name} · {ago(p.at)}</small>
            </div>
            <span className={`feed-chip c-${chip}`}>{CHIP_LABEL[chip]}</span>
          </div>

          <p className="feed-text">{p.text}</p>
          {p.kind === 'working' ? <div className="feed-thinking"><span className="feed-live" aria-hidden="true" />{s.agent.name} is on it<span className="feed-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></div> : null}

          {(p.kind === 'ready' || p.kind === 'failing') && s.prUrl ? (
            <a className="feed-pr" href={s.prUrl} target="_blank" rel="noreferrer">
              <PrIcon />
              <span className="feed-pr-text"><b>{prName(s.prUrl)}</b><small>{s.filesChanged ? `${s.filesChanged} files · ` : ''}{s.linesAdded != null ? `+${s.linesAdded} −${s.linesRemoved ?? 0}` : 'Open on GitHub'}</small></span>
              <span className={`feed-pr-state${p.kind === 'failing' ? ' bad' : ''}`}>{p.kind === 'failing' ? 'Checks failing' : s.prChecks === 'none' ? 'No checks' : 'Checks passed'}</span>
            </a>
          ) : null}

          {p.own ? <>
            <button type="button" className="feed-own-toggle" aria-expanded={own} onClick={() => setOwn(!own)}><LinesIcon />{own ? 'Hide the agent’s own words' : 'Agent’s own words'}</button>
            {own ? <div className="feed-own">{p.own}</div> : null}
          </> : null}

          {!since && options ? (
            <div className="feed-options">
              {options.map((o, i) => (
                <button key={o.label} type="button" className={`feed-opt${i === 0 ? ' primary' : ''}`} disabled={ask.busy} title={o.description || undefined}
                  onClick={() => ask.answer('answer', { answers: [{ picked: [o.label], other: '' }] })}>{o.label}</button>
              ))}
            </div>
          ) : null}
          {showAsk ? <div className="feed-ask"><AskBody s={s} busy={ask.busy} answer={ask.answer} focus={false} wallet={wallet} /></div> : null}
          {ask.err ? <p className="feed-err">{ask.err}</p> : null}

          {!since && p.kind === 'ready' ? (
            <div className="feed-options">
              <button type="button" className="feed-opt primary" disabled={busy} onClick={() => act(`/api/ship/${encodeURIComponent(s.id)}/live`, 'Merged.')}>Merge it</button>
              <a className="feed-opt" href={s.prUrl!} target="_blank" rel="noreferrer">Look at it first</a>
            </div>
          ) : null}
          {!since && p.kind === 'failing' ? (
            <div className="feed-options">
              <button type="button" className="feed-opt primary" disabled={busy} onClick={() => act(`/api/ship/${encodeURIComponent(s.id)}/fix`, 'Sent them to fix it.')}>Fix the checks</button>
            </div>
          ) : null}
          {!since && p.kind === 'stuck' && s.status !== 'ended' ? (
            <div className="feed-options">
              <button type="button" className="feed-opt" disabled={busy} onClick={() => act(`/api/stop/${encodeURIComponent(s.id)}`, 'Stopped.')}>Stop for now</button>
            </div>
          ) : null}

          {since ? <Thread s={s} since={since} said={said} version={version} /> : null}
          <Reply s={s} onSent={acted} />

          <div className="feed-actions">
            {p.mark ? (
              <button type="button" className="feed-act" onClick={() => mark(p, null)}><UndoIcon />{p.mark.status === 'done' ? 'Not done' : 'Bring back now'}</button>
            ) : <>
              <button type="button" className="feed-act" onClick={() => mark(p, 'done')}><CheckIcon />Done</button>
              <button type="button" className="feed-act" onClick={() => mark(p, 'later')}><ClockIcon />Later</button>
            </>}
            <span className="feed-spacer" />
            <button type="button" className="feed-act" onClick={() => openChat(s.id)}><ChatIcon />Open in Chats</button>
          </div>
        </div>
      </div>
    </article>
  );
}

/** What happened after you acted on a post: what Swarmville said, then your message and the agent's replies since. */
function Thread({ s, since, said, version }: { s: SessionView; since: number; said: string | null; version: number }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  useEffect(() => {
    let off = false;
    fetch(`/api/agent/${encodeURIComponent(s.id)}/chat`).then((r) => r.json()).then((v: ChatView) => {
      if (!off) setLines(v.lines.filter((l) => (l.kind === 'you' || l.kind === 'them') && l.at >= since - 5_000).slice(-4));
    }).catch(() => {});
    return () => { off = true; };
  }, [s.id, since, version]);
  return (
    <div className="feed-thread">
      {said ? <p className="feed-said">{said}</p> : null}
      {lines.map((l, i) => (
        <div key={l.id ?? i} className="feed-line">
          {l.kind === 'you' ? <span className="feed-you" aria-hidden="true">You</span> : <AgentAvatar agent={s.agent} mood={moodFor(s)} size={28} />}
          <div><b>{l.kind === 'you' ? 'You' : s.agent.name}</b><span>{l.text}</span></div>
        </div>
      ))}
    </div>
  );
}

/** The reply box. Agents Swarmville runs (or clocked out) get it straight away; one working in your terminal gets it at its next step. */
function Reply({ s, onSent }: { s: SessionView; onSent: (msg: string | null) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inTerminal = !s.runner && s.status !== 'ended';
  if (inTerminal && s.status !== 'running') {
    return <div className="feed-reply-elsewhere"><span>{s.agent.name} is in your terminal. Reply there.</span><GoTo s={s} /></div>;
  }
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    const r = await post(`/api/agent/${encodeURIComponent(s.id)}/${inTerminal ? 'steer' : 'send'}`, { text: t });
    setBusy(false);
    if (r.ok) { setText(''); onSent(r.message ?? 'Sent.'); } else setErr(r.message ?? 'Couldn’t send that.');
  };
  return (
    <>
      <form className="feed-reply" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${s.agent.name}…`} aria-label={`Reply to ${s.agent.name}`} disabled={busy} />
        <button type="submit" aria-label="Send reply" disabled={busy || !text.trim()}><SendIcon /></button>
      </form>
      {err ? <p className="feed-err">{err}</p> : null}
    </>
  );
}

const prName = (url: string) => { const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/); return m ? `${m[1]} #${m[2]}` : 'Pull request'; };

const svg = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const CheckIcon = () => <svg {...svg}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
const ClockIcon = () => <svg {...svg}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>;
const UndoIcon = () => <svg {...svg}><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>;
const ChatIcon = () => <svg {...svg}><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4A8 8 0 1 1 20 12z" /></svg>;
const SendIcon = () => <svg {...svg} width={16} height={16} strokeWidth={2.4}><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>;
const LinesIcon = () => <svg {...svg} width={13} height={13}><path d="M4 7h16M4 12h10M4 17h7" /></svg>;
const RepostIcon = () => <svg {...svg} width={14} height={14}><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>;
const PrIcon = () => <svg {...svg} width={20} height={20} strokeWidth={2}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v7" /><path d="M18 15.5V9a3 3 0 0 0-3-3h-4" /><path d="M13 3.5L10.5 6 13 8.5" /></svg>;
