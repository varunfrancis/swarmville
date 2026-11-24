import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, MERGED_DAYS, normUrl, prColumn, readyCount, rollupChecks, toBoardPr } from '../daemon/prs.ts';

const base = { draft: false, merged: false, checks: 'passing' as const, conflicts: false, review: null };
const NOW = Date.parse('2026-11-24T12:00:00Z');

test('each PR lands in one column, from what GitHub says', () => {
  assert.deepEqual(prColumn({ ...base, merged: true, checks: null }), { column: 'merged', problem: null });
  assert.deepEqual(prColumn({ ...base, draft: true }), { column: 'draft', problem: null });
  assert.deepEqual(prColumn({ ...base, draft: true, conflicts: true }), { column: 'draft', problem: 'conflicts' }, 'a draft stays a draft, with its problem as a chip');
  assert.deepEqual(prColumn({ ...base, checks: 'failing' }), { column: 'fix', problem: 'checks' });
  assert.deepEqual(prColumn({ ...base, checks: 'failing', conflicts: true }), { column: 'fix', problem: 'checks' }, 'one chip: failing checks first');
  assert.deepEqual(prColumn({ ...base, conflicts: true }), { column: 'fix', problem: 'conflicts' });
  assert.deepEqual(prColumn({ ...base, review: 'CHANGES_REQUESTED' }), { column: 'fix', problem: 'changes' });
  assert.deepEqual(prColumn({ ...base, review: 'REVIEW_REQUIRED' }), { column: 'review', problem: null });
  assert.deepEqual(prColumn({ ...base, review: 'APPROVED', checks: 'pending' }), { column: 'review', problem: null }, 'checks still running');
  assert.deepEqual(prColumn({ ...base, review: 'APPROVED' }), { column: 'ready', problem: null });
  assert.deepEqual(prColumn({ ...base, checks: 'none' }), { column: 'ready', problem: null }, 'no review required and no checks set up');
});

test('titles lose only a commit-style prefix', () => {
  assert.equal(cleanTitle('feat(slack): readable chat threads'), 'Readable chat threads');
  assert.equal(cleanTitle('fix: the gate'), 'The gate');
  assert.equal(cleanTitle('kb(kbc): the quiz has ended'), 'The quiz has ended');
  assert.equal(cleanTitle('feat!: drop node 22'), 'Drop node 22');
  assert.equal(cleanTitle('Header: move Projects into Settings'), 'Header: move Projects into Settings');
  assert.equal(cleanTitle('Chats and Feed: fold the list away'), 'Chats and Feed: fold the list away');
  assert.equal(cleanTitle('Release v0.5.0'), 'Release v0.5.0');
  assert.equal(cleanTitle('feat: '), 'Feat:', 'nothing after the prefix keeps the original');
});

test('GitHub check rollups and links read the same everywhere', () => {
  assert.equal(rollupChecks('SUCCESS'), 'passing');
  assert.equal(rollupChecks('FAILURE'), 'failing');
  assert.equal(rollupChecks('ERROR'), 'failing');
  assert.equal(rollupChecks('PENDING'), 'pending');
  assert.equal(rollupChecks(null), 'none');
  assert.equal(normUrl('https://github.com/Stable-Money/Support-Assistant/pull/929/files'), 'https://github.com/stable-money/support-assistant/pull/929');
  assert.equal(normUrl('https://example.com/x'), null);
});

const node = (o: Record<string, unknown> = {}) => ({
  url: 'https://github.com/a/b/pull/7', number: 7, title: 'fix(x): mend it', isDraft: false, state: 'OPEN', mergedAt: null,
  updatedAt: '2026-11-23T10:00:00Z', reviewDecision: null, mergeable: 'MERGEABLE', repository: { nameWithOwner: 'a/b' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...o,
});

test('a GitHub PR becomes a card, or nothing', () => {
  const p = toBoardPr(node(), 's1', NOW)!;
  assert.equal(p.column, 'ready');
  assert.equal(p.title, 'Mend it');
  assert.equal(p.sessionId, 's1');
  assert.equal(p.checks, 'passing');
  assert.equal(toBoardPr(node({ mergeable: 'CONFLICTING' }), null, NOW)!.problem, 'conflicts');
  assert.equal(toBoardPr(node({ state: 'CLOSED' }), null, NOW), null, 'closed without merging');
  const merged = toBoardPr(node({ state: 'MERGED', mergedAt: '2026-11-22T09:00:00Z' }), null, NOW)!;
  assert.equal(merged.column, 'merged');
  assert.equal(merged.checks, null);
  assert.equal(merged.updatedAt, Date.parse('2026-11-22T09:00:00Z'));
  const old = new Date(NOW - (MERGED_DAYS + 1) * 86400_000).toISOString();
  assert.equal(toBoardPr(node({ state: 'MERGED', mergedAt: old }), null, NOW), null, 'merged more than a week ago');
  assert.equal(toBoardPr({ title: 'x' }, null, NOW), null);
  assert.equal(readyCount({ syncedAt: NOW, errors: [], prs: [p, merged] }), 1);
  assert.equal(readyCount(null), 0);
});
