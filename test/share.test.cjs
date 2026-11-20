'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildStatusSummary,
  buildCompanyShare,
  parseCompanyShare,
  findDuplicateNames,
  ShareFormatError,
} = require('../src/shared/share.cjs');

const NOW = new Date('2026-11-20T10:00:00+09:00');

function sampleCompanies() {
  return [
    {
      id: 'a', name: 'あおば商事', status: 'INTERVIEWING', industry: '商社', priority: 5,
      memo: '秘密のメモ', myPageId: 'user-123', ratingSalary: 5, aiExtractedJson: '{"analysis":"x"}',
      description: '総合商社', salary: '月給30万円', annualIncome: 600, isEarlySelection: true,
      myPageUrl: 'https://mypage.example.jp/login',
      steps: [
        { stepName: 'ES', stepOrder: 1, status: 'PASSED', memo: 'ステップメモ', dueDate: '2026-10-01T00:00:00Z' },
        { stepName: '一次面接', stepOrder: 2, status: 'PASSED' },
        { stepName: '二次面接', stepOrder: 3, status: 'PENDING' },
      ],
      events: [
        { title: '二次面接 with 部長', eventType: 'INTERVIEW', startAt: '2026-11-25T14:00:00+09:00', allDay: false, isDone: false, memo: '面接メモ' },
        { title: '会社説明会', eventType: 'BRIEFING', startAt: '2026-12-01T10:00:00+09:00', allDay: false, isDone: false, location: 'オンライン' },
        { title: '過去のES締切', eventType: 'ES_DEADLINE', startAt: '2026-10-01T00:00:00+09:00', allDay: true, isDone: true },
      ],
    },
    { id: 'b', name: 'いろは銀行', status: 'OFFER', steps: [], events: [] },
    { id: 'c', name: 'うみ電機', status: 'REJECTED', steps: [], events: [] },
    { id: 'd', name: 'えがお食品', status: 'INTERESTED', steps: [], events: [] },
    { id: 'e', name: 'おか製薬', status: 'APPLIED', steps: [], events: [] },
  ];
}

test('status summary: simple level shows counts only', () => {
  const text = buildStatusSummary(sampleCompanies(), { level: 'simple', now: NOW });
  assert.match(text, /2026\/11\/20 時点/);
  assert.match(text, /エントリー 4社（選考中 2社・内定 1社）/);
  assert.match(text, /応募済み 1 \/ 面接中 1/);
  assert.match(text, /不合格 1 \/ 辞退 0/);
  assert.match(text, /検討中 1社/);
  assert.doesNotMatch(text, /あおば商事|いろは銀行/);
});

test('status summary: standard level lists names per status in progress order', () => {
  const text = buildStatusSummary(sampleCompanies(), { level: 'standard', now: NOW });
  assert.match(text, /■ 内定（1社）\n  いろは銀行/);
  assert.match(text, /■ 面接中（1社）\n  あおば商事/);
  assert.ok(text.indexOf('■ 内定') < text.indexOf('■ 面接中'));
  assert.ok(text.indexOf('■ 応募済み') < text.indexOf('■ 不合格'));
  assert.doesNotMatch(text, /選考:/);
});

test('status summary: detailed level shows step progress and next event without private data', () => {
  const text = buildStatusSummary(sampleCompanies(), { level: 'detailed', now: NOW });
  assert.match(text, /・あおば商事（商社・早期選考）/);
  assert.match(text, /選考: ES✓ → 一次面接✓ → 二次面接/);
  const next = new Date('2026-11-25T14:00:00+09:00');
  const expected = `次の予定: ${next.getMonth() + 1}/${next.getDate()}(${'日月火水木金土'[next.getDay()]}) ${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')} 面接`;
  assert.ok(text.includes(expected), text);
  for (const secret of ['秘密のメモ', 'user-123', 'ステップメモ', '面接メモ', '部長', 'analysis', '★', '月給']) {
    assert.ok(!text.includes(secret), `must not leak ${secret}`);
  }
});

test('status summary: filters and anonymization', () => {
  const text = buildStatusSummary(sampleCompanies(), {
    level: 'standard', includeInterested: false, includeClosed: false, anonymize: true, now: NOW,
  });
  assert.doesNotMatch(text, /検討中|不合格|えがお食品|うみ電機/);
  assert.doesNotMatch(text, /あおば商事|いろは銀行|おか製薬/);
  assert.match(text, /■ 内定（1社）\n  企業A/);
  assert.match(text, /エントリー 3社/);
  assert.match(buildStatusSummary([], { now: NOW }), /共有できる企業はまだありません/);
});

test('company share excludes personal fields and interview schedules', () => {
  const data = buildCompanyShare([sampleCompanies()[0]], { now: NOW });
  assert.equal(data.format, 'job-tracker-company-share');
  const [c] = data.companies;
  assert.equal(c.name, 'あおば商事');
  assert.equal(c.description, '総合商社');
  assert.equal(c.annualIncome, 600);
  assert.equal(c.myPageUrl, 'https://mypage.example.jp/login');
  for (const key of ['memo', 'myPageId', 'priority', 'status', 'ratingSalary', 'aiExtractedJson', 'id', 'interviews']) {
    assert.ok(!(key in c), `must not include ${key}`);
  }
  assert.deepEqual(c.steps, [
    { stepName: 'ES', stepOrder: 1 },
    { stepName: '一次面接', stepOrder: 2 },
    { stepName: '二次面接', stepOrder: 3 },
  ]);
  assert.deepEqual(c.events.map((e) => e.title), ['会社説明会']);
  assert.ok(!JSON.stringify(data).includes('秘密'));

  const minimal = buildCompanyShare([sampleCompanies()[0]], {
    now: NOW, includeResearch: false, includeCompensation: false, includeSteps: false, includeEvents: false,
  }).companies[0];
  assert.ok(!('description' in minimal) && !('salary' in minimal) && !('annualIncome' in minimal));
  assert.ok(!('steps' in minimal) && !('events' in minimal));
});

test('parseCompanyShare round-trips and rejects unsafe or wrong input', () => {
  const data = buildCompanyShare(sampleCompanies(), { now: NOW });
  const parsed = parseCompanyShare(`友達からのメッセージ\n${JSON.stringify(data)}\n`);
  assert.equal(parsed.companies.length, 5);

  const tampered = JSON.parse(JSON.stringify(data));
  tampered.companies[0].memo = '混入';
  tampered.companies[0].status = 'OFFER';
  tampered.companies[0].websiteUrl = 'javascript:alert(1)';
  tampered.companies[0].events.push({ title: '面接', eventType: 'INTERVIEW', startAt: '2026-12-01T10:00:00Z' });
  const [c] = parseCompanyShare(tampered).companies;
  assert.ok(!('memo' in c) && !('status' in c));
  assert.equal(c.websiteUrl, null);
  assert.ok(c.events.every((e) => e.eventType !== 'INTERVIEW'));

  assert.throws(() => parseCompanyShare(''), ShareFormatError);
  assert.throws(() => parseCompanyShare('not json'), ShareFormatError);
  assert.throws(() => parseCompanyShare({ format: 'job-tracker-backup' }), /バックアップファイル/);
  assert.throws(() => parseCompanyShare({ format: 'job-tracker-company-share', version: 2, companies: [{ name: 'x' }] }), /版/);
  assert.throws(() => parseCompanyShare({ format: 'job-tracker-company-share', version: 1, companies: [{ name: ' ' }] }), /企業名/);
});

test('findDuplicateNames ignores spacing, width and 株式会社', () => {
  const dup = findDuplicateNames(
    [{ name: '株式会社 あおば商事' }, { name: 'ＡＢＣ' }, { name: '新しい会社' }],
    [{ name: 'あおば商事' }, { name: 'abc株式会社' }]
  );
  assert.deepEqual(dup, [true, true, false]);
});

test('DatabaseStore.importSharedCompanies adds companies as INTERESTED atomically', () => {
  const { DatabaseStore } = require('../src/backend/db.cjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-share-'));
  const store = new DatabaseStore({ dataDir: tmpDir });
  try {
    const payload = JSON.stringify(buildCompanyShare(sampleCompanies(), { now: NOW }));

    const result = store.importSharedCompanies(payload, [0, 4]);
    assert.deepEqual(result.counts, { companies: 2, events: 1 });
    const list = store.listCompanies();
    assert.equal(list.length, 2);
    const aoba = list.find((c) => c.name === 'あおば商事');
    assert.equal(aoba.status, 'INTERESTED');
    assert.equal(aoba.priority, 3);
    assert.equal(aoba.memo, null);
    assert.equal(aoba.myPageId, null);
    assert.equal(aoba.isEarlySelection, true);
    assert.deepEqual(aoba.steps.map((s) => [s.stepName, s.status]), [['ES', 'PENDING'], ['一次面接', 'PENDING'], ['二次面接', 'PENDING']]);
    assert.deepEqual(aoba.events.map((e) => [e.title, e.eventType]), [['会社説明会', 'BRIEFING']]);

    const before = store.listCompanies().length;
    assert.throws(() => store.importSharedCompanies(payload, []), /1社以上/);
    assert.throws(() => store.importSharedCompanies(payload, [99]), /指定が正しくありません/);
    assert.throws(() => store.importSharedCompanies('{"format":"job-tracker-backup"}'), /バックアップファイル/);
    assert.equal(store.listCompanies().length, before);

    // A failure part-way through (after the first company was inserted) must leave nothing behind
    store.createEvent = () => {
      throw new Error('boom');
    };
    assert.throws(() => store.importSharedCompanies(payload), /boom/);
    delete store.createEvent;
    assert.equal(store.listCompanies().length, before);

    // Regular writes still work after a rolled-back nested transaction
    store.createCompany({ name: '後から追加' });
    assert.equal(store.listCompanies().length, before + 1);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
