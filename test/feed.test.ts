import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { feedPosts, inFilter, oneTap, postKey, postKind, postText, UNDO_MS, waitingCount } from '../web/src/feed.ts';
import { feedMarks, LATER_MS, markFeed } from '../daemon/feed.ts';
import { openDb } from '../daemon/db.ts';

const NOW = new Date(2026, 10, 19, 15, 0).getTime();
const H = 3600_000;
let n = 0;
const mk = (o: Record<string, unknown> = {}): any => ({
  id: `s${++n}`, status: 'idle', away: false, endedAt: null, lastEventAt: NOW - H, startedAt: NOW - 2 * H, runner: undefined, scheduled: false,
  agent: { name: 'Tiki' }, focus: 'Build the Feed tab', title: 'job', prompts: 1, projectId: 'p1', projectName: 'Agent Logbook',
  action: null, ask: null, payment: null, needsMessage: null, outcome: null, plainOutcome: null, stuck: null,
  prUrl: null, prState: null, prChecks: null, stamp: null, ...o,
});
const question = (multiSelect = false) => ({ id: 'a1', tool: 'AskUserQuestion', title: 'Question', questions: [{ question: 'Which way?', header: 'Way', multiSelect, options: [{ label: 'Left', description: '' }, { label: 'Right', description: '' }] }] });

test('each job makes one kind of post, or none', () => {
  assert.equal(postKind(mk({ status: 'needs_input', ask: question() })), 'question');
  assert.equal(postKind(mk({ status: 'needs_input', ask: { id: 'a2', tool: 'ExitPlanMode', title: 'Plan' } })), 'plan');
  assert.equal(postKind(mk({ status: 'needs_input', ask: { id: 'a3', tool: 'Bash', title: 'Run npm test' } })), 'permission');
  assert.equal(postKind(mk({ status: 'needs_input', outcome: 'Want me to merge it?' })), 'asked');
  assert.equal(postKind(mk({ status: 'needs_input', payment: { id: 'w1' } })), null, 'the Wallet answers payments');
  assert.equal(postKind(mk({ status: 'running', stuck: { count: 3, problem: 'npm test failed' } })), 'stuck');
  assert.equal(postKind(mk({ prUrl: 'https://github.com/a/b/pull/1', prState: 'open', prChecks: 'failing' })), 'failing');
  assert.equal(postKind(mk({ prUrl: 'https://github.com/a/b/pull/1', prState: 'open', prChecks: 'passing', outcome: 'PR is up' })), 'ready');
  assert.equal(postKind(mk({ status: 'running', prUrl: 'https://github.com/a/b/pull/1', prState: 'open', prChecks: 'passing', outcome: 'x' })), 'working', 'not ready while they still work on it');
  assert.equal(postKind(mk({ prState: 'merged', outcome: 'Merged' })), 'shipped');
  assert.equal(postKind(mk({ outcome: 'Fixed the header' })), 'finished');
  assert.equal(postKind(mk({ status: 'running', outcome: 'Earlier reply' })), 'working');
  assert.equal(postKind(mk({ status: 'running' })), null, 'a first turn at work stays out of the feed');
  assert.equal(postKind(mk({ status: 'idle' })), null, 'nothing said, no post');
  assert.equal(postKind(mk({ status: 'idle', outcome: 'Plan is set. Which projects should it cover?' })), 'asked', 'idle and asking: your turn');
  assert.equal(postKind(mk({ status: 'idle', away: true, outcome: 'Which projects?' })), 'finished', 'long gone quiet: just news');
  assert.equal(postKind(mk({ status: 'ended', outcome: 'Which projects?' })), 'finished');
});

test('the post shows the small model’s words, with the agent’s own words one tap away', () => {
  const s = mk({ outcome: 'Merged as PR #98, CI green, kickstarted the daemon.', plainOutcome: 'Your change is live.' });
  assert.deepEqual(postText(s, 'finished'), { text: 'Your change is live.', own: 'Merged as PR #98, CI green, kickstarted the daemon.' });
  // not rewritten yet: the agent's first line, and nothing extra to show
  assert.deepEqual(postText(mk({ outcome: 'Done.' }), 'finished'), { text: 'Done.', own: null });
  assert.equal(postText(mk({ status: 'needs_input', ask: question() }), 'question').text, 'Which way?');
  assert.equal(postText(mk({ stuck: { count: 4, problem: 'TypeError: x is undefined' } }), 'stuck').own, 'TypeError: x is undefined');
});

test('a post’s version changes when something new happens on the job', () => {
  const a = mk({ stuck: { count: 3, problem: 'x' } });
  const b = { ...a, stuck: { count: 4, problem: 'x' } };
  assert.notEqual(postKey(a, 'stuck'), postKey(b, 'stuck'));
  const f1 = mk({ outcome: 'one' }), f2 = { ...f1, outcome: 'two' };
  assert.notEqual(postKey(f1, 'finished'), postKey(f2, 'finished'));
  assert.equal(postKey(f1, 'finished'), postKey({ ...f1 }, 'finished'));
});

test('waiting posts go on top; old news, scheduled jobs and empty sessions stay out', () => {
  const fin = mk({ outcome: 'Fixed it', lastEventAt: NOW - 10 * 60_000 });
  const ask = mk({ status: 'needs_input', ask: question(), lastEventAt: NOW - 2 * H });
  const oldNews = mk({ outcome: 'Old', lastEventAt: NOW - 30 * H });
  const oldReview = mk({ prUrl: 'https://github.com/a/b/pull/2', prState: 'open', prChecks: 'passing', outcome: 'PR', lastEventAt: NOW - 40 * H });
  const routine = mk({ outcome: 'Nightly report sent', scheduled: true });
  const empty = mk({ outcome: 'hi', focus: null, title: 'New session', prompts: 0 });
  const ids = feedPosts([fin, ask, oldNews, oldReview, routine, empty], [], NOW).map((p) => p.id);
  assert.deepEqual(ids, [ask.id, oldReview.id, fin.id]);
});

test('Done and Later hide a post until something new happens; then it comes back as a repost', () => {
  const s = mk({ status: 'running', stuck: { count: 3, problem: 'x' } });
  const key = postKey(s, 'stuck');
  const done = { id: s.id, key, status: 'done' as const, at: NOW - 10 * 60_000, until: null };
  let [p] = feedPosts([s], [done], NOW);
  assert.ok(p.mark);
  assert.equal(inFilter(p, 'all', NOW), false);
  assert.equal(inFilter(p, 'done', NOW), true);
  assert.equal(inFilter(p, 'waiting', NOW), false);
  assert.equal(waitingCount([p]), 0);
  // one more failed try: the old Done no longer applies
  [p] = feedPosts([{ ...s, stuck: { count: 4, problem: 'x' } }], [done], NOW);
  assert.equal(p.mark, null);
  assert.equal(p.repost, 'Reposted · still stuck after 4 tries');
  assert.equal(waitingCount([p]), 1);
  // Later comes back by itself once its time is up
  const later = { id: s.id, key, status: 'later' as const, at: NOW - 3 * H, until: NOW - H };
  [p] = feedPosts([s], [later], NOW);
  assert.equal(p.mark, null);
  assert.equal(p.repost, 'Back from Later');
});

test('a post you just cleared stays in All as a thin row with Undo for a few minutes', () => {
  const s = mk({ outcome: 'Fixed it' });
  const m = { id: s.id, key: postKey(s, 'finished'), status: 'done' as const, at: NOW - 60_000, until: null };
  const [p] = feedPosts([s], [m], NOW);
  assert.equal(inFilter(p, 'all', NOW), true);
  assert.equal(inFilter(p, 'all', NOW + UNDO_MS), false);
});

test('one tap answers only a single, single-choice question', () => {
  assert.deepEqual(oneTap(mk({ ask: question() }))?.map((o) => o.label), ['Left', 'Right']);
  assert.equal(oneTap(mk({ ask: question(true) })), null);
  assert.equal(oneTap(mk({ ask: { ...question(), questions: [...question().questions, ...question().questions] } })), null);
  assert.equal(oneTap(mk({ ask: { id: 'p', tool: 'ExitPlanMode', title: 'Plan' } })), null);
});

test('marks are kept in the database, replaced per post, and cleared by Undo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmville-feed-'));
  try {
    const db = openDb(path.join(dir, 'db.sqlite'));
    markFeed(db, 's1', 'k1', 'done', NOW);
    markFeed(db, 's2', 'k2', 'later', NOW);
    assert.deepEqual(feedMarks(db).map((m) => [m.id, m.status, m.until]), [['s1', 'done', null], ['s2', 'later', NOW + LATER_MS]]);
    markFeed(db, 's1', 'k1b', 'later', NOW + 1);
    assert.deepEqual(feedMarks(db).map((m) => [m.id, m.key]), [['s2', 'k2'], ['s1', 'k1b']]);
    markFeed(db, 's2', 'k2', null, NOW + 2);
    assert.deepEqual(feedMarks(db).map((m) => m.id), ['s1']);
    // a week on, old marks are forgotten
    markFeed(db, 's3', 'k3', 'done', NOW + 8 * 24 * H);
    assert.deepEqual(feedMarks(db).map((m) => m.id), ['s3']);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
