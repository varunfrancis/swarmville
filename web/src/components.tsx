import { useState } from 'react';
import type { SessionView } from '../../daemon/types.ts';
import { plainAction, STAMP, STATUS, useVoice } from './copy.ts';
import { post } from './useSwarmville.ts';

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot s-${status}`} aria-hidden="true" />;
}

export function StatusPill({ status }: { status: SessionView['status'] }) {
  const voice = useVoice();
  return <span className={`pill s-${status}`}>{STATUS[voice][status]}</span>;
}

export function Stamp({ stamp, big }: { stamp: NonNullable<SessionView['stamp']>; big?: boolean }) {
  const voice = useVoice();
  return <span className={`stamp st-${stamp}${big ? ' big' : ''}`}>{STAMP[voice][stamp]}</span>;
}

export function PrChip({ url, state }: { url: string | null; state: string | null }) {
  const voice = useVoice();
  if (!url) return null;
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  const label = voice === 'plain'
    ? (state === 'merged' ? 'Approved & live' : state === 'closed' ? 'Review closed' : 'In review')
    : `PR #${n} ${state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open'}`;
  return <a className={`prchip pr-${state ?? 'open'}`} href={url} target="_blank" rel="noreferrer">{label}</a>;
}

/** "Go to Pip": brings the agent's VS Code terminal forward; falls back to copying a resume command. */
export function GoTo({ s, primary }: { s: SessionView; primary?: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const live = s.status !== 'ended';
  if (s.runner) return null; // Swarmville runs them: you talk to them in their chat, not in a terminal
  const cmd =`${s.cwd ? `cd ${JSON.stringify(s.cwd)} && ` : ''}claude --resume ${s.id}`;
  const click = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (live) {
      const r = await post(`/api/jump/${encodeURIComponent(s.id)}`);
      setMsg(r.via === 'extension' ? null : r.message ?? null);
    } else {
      const r = await post(`/api/resume/${encodeURIComponent(s.id)}`);
      if (!r.ok) { try { await navigator.clipboard.writeText(cmd); setMsg(`${r.message ?? 'Couldn’t reopen it.'} Command copied instead.`); } catch { setMsg(cmd); } }
      else setMsg(r.message ?? null);
    }
    setTimeout(() => setMsg(null), 4000);
  };
  return (
    <span className="goto">
      <button className={primary ? 'btn dark' : 'ghost small'} onClick={click} title={live ? 'Open their terminal in VS Code' : `Reopen this conversation in a terminal (${cmd})`}>
        {live ? <>Go to {s.agent.name}{primary ? <kbd>↵</kbd> : null}</> : 'Resume this job'}
      </button>
      {msg ? <span className="goto-msg" role="status">{msg}</span> : null}
    </span>
  );
}

/** "Clock out": stops a running agent and closes its terminal, after a confirmation in place (no pop-up dialog). */
export function ClockOut({ s }: { s: SessionView }) {
  const voice = useVoice();
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'done'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  if (s.status === 'ended') return null;
  const name = s.agent.name;
  const working = s.status === 'running';
  const stop = (e: React.MouseEvent) => { e.stopPropagation(); };
  const yes = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStep('busy');
    const r = await post(`/api/stop/${encodeURIComponent(s.id)}`);
    setStep(r.ok ? 'done' : 'idle');
    setMsg(r.ok ? `${name} clocked out` : r.message ?? 'Couldn’t clock them out.');
    if (!r.ok) setTimeout(() => setMsg(null), 5000);
  };
  if (step === 'done') return <span className="clockout-msg ok" role="status">{msg}</span>;
  return (
    <span className="clockout" onClick={stop}>
      {step === 'idle' ? (
        <button className="ghost small risky" onClick={(e) => { e.stopPropagation(); setStep('confirm'); }} title={`Stop ${name} and close their terminal. Asks you first.`}>Clock out</button>
      ) : (
        <span className={`clockout-confirm${working ? ' hot' : ''}`} role="alertdialog" aria-label={`Clock ${name} out?`}>
          <span className="cc-text">
            {working
              ? <><b>{name} is still working{s.action ? `: right now, ${(plainAction(s.action, voice) ?? '').replace(/^\w/, (c) => c.toLowerCase())}` : ''}.</b> Stop them anyway? </>
              : <><b>Clock {name} out?</b> </>}
            Their terminal closes. The conversation is saved and you can resume it any time.
          </span>
          <span className="cc-actions">
            <button className="btn small stop" disabled={step === 'busy'} onClick={yes} autoFocus>{working ? `Stop ${name}` : 'Clock out'}</button>
            <button className="ghost small" disabled={step === 'busy'} onClick={(e) => { e.stopPropagation(); setStep('idle'); }}>Keep working</button>
          </span>
        </span>
      )}
      {msg ? <span className="clockout-msg" role="status">{msg}</span> : null}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** Remembers whether a tab's left list is folded away (Chats and Feed each keep their own). */
export function useNavHidden(key: string): [boolean, () => void] {
  const read = () => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
  const [hidden, setHidden] = useState(read);
  const toggle = () => { const next = !hidden; setHidden(next); try { localStorage.setItem(key, next ? '1' : '0'); } catch {} };
  return [hidden, toggle];
}

/** The small sidebar button that folds the left list away and brings it back. */
export function NavToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  const label = hidden ? 'Show the list' : 'Hide the list';
  return (
    <button type="button" className="nav-toggle" onClick={onToggle} aria-label={label} aria-expanded={!hidden} title={label}>
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="2" y="3" width="14" height="12" rx="2.5" /><path d="M7 3v12" />
        {hidden ? <path d="M10.5 7.5 12 9l-1.5 1.5" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M12 7.5 10.5 9 12 10.5" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
    </button>
  );
}
