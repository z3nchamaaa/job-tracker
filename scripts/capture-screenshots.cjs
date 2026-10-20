#!/usr/bin/env node
'use strict';

require("../src/backend/runtime.cjs").assertSupportedRuntime();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAppServer } = require('../src/backend/server.cjs');
const { launchPage } = require('./browser.cjs');

const repoRoot = path.resolve(__dirname, '..');
const screenshotsDir = path.join(repoRoot, 'dist', 'screenshots');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const macHostBin = path.join(
  repoRoot,
  'dist',
  'mac-arm64',
  '就活トラッカー.app',
  'Contents',
  'MacOS',
  'JobTrackerHost'
);

const activeChildren = new Set();

function terminateChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {}
  const killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }, 1500);
  if (killTimer.unref) killTimer.unref();
}

function runProcessWithTimeout(command, args, { timeoutMs = 25000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      terminateChild(child);
      reject(
        new Error(
          `Process timed out after ${timeoutMs}ms: ${path.basename(command)} ${args.join(' ')}\nstderr: ${stderr.slice(-500)}`
        )
      );
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      terminateChild(child);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      if (code !== 0) {
        reject(
          new Error(
            `Process exited with code=${code} signal=${signal}: ${path.basename(command)}\nstderr: ${stderr.slice(-800)}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function seedFictionalData(dbStore, profileStore) {
  profileStore.saveProfile({
    version: 1,
    completed: true,
    major: '情報理工学専攻（分散システム・クラウド基盤）',
    industries: 'クラウドSaaS、通信インフラ、金融テクノロジー',
    roles: 'ソフトウェアエンジニア、SRE',
    priorities: '社会影響の大きい基盤技術を扱い、若手から設計・運用の一貫した裁量を持てること',
    strengths: '学内開発コンテスト運営で審査自動化基盤を構築し、参加者を前年比180%へ拡大した経験',
  });

  const c1 = dbStore.createCompany({
    name: '株式会社サンプルクラウドシステムズ',
    industry: 'クラウドSaaS・基盤',
    jobType: 'ソフトウェアエンジニア',
    status: 'INTERVIEWING',
    isEarlySelection: true,
    priority: 5,
    location: '東京都渋谷区',
    websiteUrl: 'https://example.jp/sample-cloud',
    myPageUrl: 'https://example.jp/mypage/sample-cloud',
    myPageId: 'demo_user_001',
    annualIncome: 580,
    startingSalary: 340000,
    bonusTimes: 2,
    bonusMonths: 4.5,
    annualHolidays: 125,
    fixedOvertime: 'なし（全額別途支給）',
    housingAllowance: '月3.5万円（オフィス3km圏内）',
    remoteWork: 'ハイブリッド可（週3リモート）',
    benefits: 'リモートワーク手当、技術書籍購入補助、確定拠出年金',
    description: '法人向けマルチクラウド管理基盤とゼロトラスト認証基盤を提供する国内SaaS企業。',
    memo: '早期選考ルート。一次面接通過、次回は技術面接。',
    aiExtractedJson: JSON.stringify({
      generatedByAi: true,
      verifiedAt: '2026-10-19',
      sources: [
        {
          title: '公式新卒採用募集要項（架空サンプル）',
          url: 'https://example.jp/recruit/sample-cloud',
          verifiedAt: '2026-10-19',
        },
      ],
      interviewPrepTips: {
        fitLevel: '高',
        fitReason: '分散システム・クラウド基盤の専攻領域と高い親和性があります。',
        appealPoints: ['審査自動化基盤の構築経験', '定量的な課題解決プロセス'],
        idealCandidate: '技術で本質的な課題を解決し、チームで協働できるエンジニア',
        expectedQuestions: ['高負荷時にシステム障害が起きた際、どのように原因を切り分けますか？'],
        reverseQuestions: ['新卒1年目のエンジニアが担当するコンポーネントの規模感を教えてください。'],
      },
    }),
  });

  const c2 = dbStore.createCompany({
    name: '架空フィンテックソリューションズ株式会社',
    industry: '金融IT・決済基盤',
    jobType: 'バックエンドエンジニア',
    status: 'FINAL',
    isEarlySelection: false,
    priority: 5,
    location: '東京都千代田区',
    myPageUrl: 'https://example.jp/mypage/fintech-demo',
    myPageId: 'demo_user_002',
    annualIncome: 620,
    startingSalary: 360000,
    bonusTimes: 2,
    bonusMonths: 5.0,
    annualHolidays: 124,
    fixedOvertime: '20時間分含む',
    housingAllowance: '月4万円',
    remoteWork: '週2リモート可',
    benefits: '社員持株会、カフェテリアプラン、資格報奨金',
    memo: '最終面接案内受領済。',
  });

  dbStore.createCompany({
    name: 'みらい通信ネットワーク株式会社',
    industry: '通信インフラ',
    jobType: 'ネットワークエンジニア',
    status: 'OFFER',
    isEarlySelection: false,
    priority: 4,
    location: '東京都港区',
    annualIncome: 540,
    startingSalary: 310000,
    bonusTimes: 2,
    bonusMonths: 4.5,
    annualHolidays: 128,
    fixedOvertime: 'なし',
    housingAllowance: '独身寮・社宅制度あり',
    remoteWork: '一部可',
    benefits: '財形貯蓄、育児短時間勤務、リフレッシュ休暇',
    memo: '内定獲得。承諾期限は来月末。',
  });

  dbStore.createCompany({
    name: 'あおぞらモビリティ研究所',
    industry: '自動運転・ロボティクス',
    jobType: '研究開発エンジニア',
    status: 'ES_PASSED',
    isEarlySelection: true,
    priority: 4,
    location: '神奈川県横浜市',
    annualIncome: 510,
    startingSalary: 300000,
    bonusTimes: 2,
    bonusMonths: 4.0,
    annualHolidays: 122,
    fixedOvertime: 'なし',
    housingAllowance: '月2.5万円',
    remoteWork: '週2リモート可',
    benefits: '研究学会参加補助、フレックスタイム制',
    memo: 'ES通過、来週コーディング試験。',
  });

  dbStore.createCompany({
    name: 'コスモス情報システム株式会社',
    industry: 'SIer・公共システム',
    jobType: 'システムエンジニア',
    status: 'APPLIED',
    isEarlySelection: false,
    priority: 3,
    location: '大阪府大阪市',
    annualIncome: null,
    startingSalary: 270000,
    bonusTimes: 2,
    bonusMonths: null,
    annualHolidays: 123,
    fixedOvertime: 'なし',
    housingAllowance: '住宅手当あり',
    remoteWork: '一部可',
    benefits: '退職金制度、資格手当',
    memo: '想定年収は未確認（比較画面での未確認末尾ソート確認用）。',
  });

  dbStore.createStep({
    companyId: c1.id,
    stepName: 'ES・書類選考',
    status: 'PASSED',
    dueDate: new Date(Date.now() - 5 * 86400000).toISOString(),
    memo: '提出完了・通過',
  });
  const step2 = dbStore.createStep({
    companyId: c1.id,
    stepName: '技術面接（二次）',
    status: 'PENDING',
    dueDate: new Date(Date.now() + 2 * 86400000).toISOString(),
    memo: 'システム設計ディスカッション',
  });

  dbStore.createInterviewNote({
    companyId: c1.id,
    stepName: '一次面接（現場エンジニア）',
    interviewer: '基盤開発部 テックリード',
    interviewDate: '2026-10-12T10:00:00Z',
    questions: '卒業研究のテーマと工夫した点',
    answers: '分散キャッシュの整合性検証手法について説明',
    feedback: '具体的な設計意図を丁寧に聞いてくれる雰囲気だった',
    nextAction: '次回技術面接に向けて設計図を整理',
  });

  dbStore.createEvent({
    companyId: c1.id,
    stepId: step2.id,
    title: '二次技術面接（オンライン）',
    eventType: 'INTERVIEW',
    startAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    endAt: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString(),
    allDay: false,
    location: 'オンライン会議室',
    memo: '開始10分前に入室',
    isDone: false,
  });

  dbStore.createEvent({
    companyId: c2.id,
    title: '役員最終面接',
    eventType: 'INTERVIEW',
    startAt: new Date(Date.now() + 4 * 86400000).toISOString(),
    endAt: null,
    allDay: false,
    location: '東京本社 15F',
    memo: '学生証・履歴書原本持参',
    isDone: false,
  });

  dbStore.createEvent({
    companyId: null,
    title: 'IT業界合同技術セミナー（企業未指定イベント）',
    eventType: 'BRIEFING',
    startAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    endAt: null,
    allDay: true,
    location: 'オンライン配信',
    memo: 'クラウドインフラ比較セッション',
    isDone: false,
  });
}

const viewportResults = [];
async function captureWithChrome(url, width, height, outputPath, scale = 1) {
  const browser = await launchPage(url, { width: width / scale, height: height / scale, scale });
  try {
    const deadline = Date.now() + 10000;
    while (!await browser.evaluate("document.querySelectorAll('.metric-card').length === 5")) {
      if (Date.now() > deadline) throw new Error('App did not render');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const metrics = await browser.evaluate(`({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      narrowMedia: matchMedia('(max-width:400px)').matches,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((el) => ({
        top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom,
        footerBottom: el.querySelector('.modal-footer')?.getBoundingClientRect().bottom
      })) })`);
    if (metrics.width !== width / scale || metrics.height !== height / scale) throw new Error('Viewport dimensions mismatch');
    if (width / scale <= 400 && !metrics.narrowMedia) throw new Error('Media query width mismatch');
    if (metrics.horizontalOverflow) throw new Error(`Horizontal overflow: ${path.basename(outputPath)}`);
    for (const dialog of metrics.dialogs) {
      if (dialog.top < -1 || dialog.bottom > height / scale + 1 || dialog.footerBottom > height / scale + 1) throw new Error('Dialog outside viewport');
    }
    const { data } = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const png = Buffer.from(data, 'base64');
    if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) throw new Error('PNG dimensions mismatch');
    fs.writeFileSync(outputPath, png);
    viewportResults.push({ file: path.basename(outputPath), ...metrics, screenshotWidth: width, screenshotHeight: height, zoomEquivalent: scale });
  } finally { await browser.close(); }
}

async function main() {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-screenshots-'));

  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  };

  const appServer = createAppServer({
    dataDir: tempDir,
    safeStorage,
    allowDevBrowserSession: true,
  });

  try {
    seedFictionalData(appServer.dbStore, appServer.profileStore);

    const { bootstrapUrl } = await appServer.start(0);

    try {
      const targets = [
        { file: 'kanban-1280x820.png', w: 1280, h: 820, query: '' },
        { file: 'kanban-768x900.png', w: 768, h: 900, query: '' },
        { file: 'kanban-390x844.png', w: 390, h: 844, query: '' },
        { file: 'kanban-360x740.png', w: 360, h: 740, query: '' },
        { file: 'compensation-1280x820.png', w: 1280, h: 820, query: 'view=compensation' },
        { file: 'schedule-1280x820.png', w: 1280, h: 820, query: 'view=schedule' },
        { file: 'modal-prompt-lowheight-860x480.png', w: 860, h: 480, query: 'modal=prompt' },
        { file: 'modal-prompt-zoom200-1280x820.png', w: 1280, h: 820, query: 'modal=prompt', scale: 2 },
        { file: 'modal-detail-1280x820.png', w: 1280, h: 820, query: 'modal=detail' },
      ];

      for (const t of targets) {
        if (process.argv.includes('--native-only')) break;
        const out = path.join(screenshotsDir, t.file);
        const targetUrl = t.query ? `${bootstrapUrl}&${t.query}` : bootstrapUrl;
        await captureWithChrome(targetUrl, t.w, t.h, out, t.scale || 1);
        console.log(`Captured ${t.file} (${t.w}x${t.h})`);
      }
    } finally {
      await appServer.stop();
    }

    // Also run native macOS WKWebView smoke test & snapshot against the seeded tempDir
    if (process.platform === 'darwin' && fs.existsSync(macHostBin)) {
      const nativeTargets = [
        { file: 'native-macos-wkwebview-smoke.png', width: 1280, height: 820 },
        { file: 'native-macos-prompt-360x740.png', width: 360, height: 740, query: 'modal=prompt' },
        { file: 'native-macos-kanban-390x844.png', width: 390, height: 844 },
        { file: 'native-macos-kanban-768x820.png', width: 768, height: 820 },
        { file: 'native-macos-prompt-860x480.png', width: 860, height: 480, query: 'modal=prompt' },
        { file: 'native-macos-import-360x480.png', width: 360, height: 480, query: 'modal=data' },
        { file: 'native-macos-detail-360x480.png', width: 360, height: 480, query: 'modal=detail' },
      ];
      for (const target of nativeTargets) {
      const nativeSnap = path.join(screenshotsDir, target.file);
      const { stdout } = await runProcessWithTimeout(
        macHostBin,
        ['--smoke-test', '--snapshot', nativeSnap, '--size', `${target.width}x${target.height}`, ...(target.query ? ['--url-query', target.query] : [])],
        {
          timeoutMs: 25000,
          env: {
            ...process.env,
            JOB_TRACKER_DATA_DIR: tempDir,
          },
        }
      );
      if (!fs.existsSync(nativeSnap) || fs.statSync(nativeSnap).size === 0) {
        throw new Error(`Native WKWebView snapshot missing or empty: ${nativeSnap}`);
      }
      const metrics = JSON.parse(stdout.trim().split('SMOKE_TEST_OK:')[1]);
      if (metrics.width !== target.width || metrics.height !== target.height || metrics.overflow) throw new Error(`Native viewport mismatch: ${target.file}: ${JSON.stringify(metrics)}`);
      for (const dialog of metrics.dialogs || []) {
        if (dialog.top < 32 || dialog.bottom > target.height + 1 || dialog.left < -1 || dialog.right > target.width + 1 || dialog.bodyHeight <= 0 || dialog.bodyOverflow) {
          throw new Error(`Native modal layout regression: ${target.file}: ${JSON.stringify(dialog)}`);
        }
      }
      console.log(`Native WKWebView smoke test: ${stdout.trim()}`);
      viewportResults.push({ native: true, file: target.file, ...metrics });
      }
    }
    if (process.argv.includes('--native-only') && fs.existsSync(path.join(screenshotsDir, 'viewport-report.json'))) {
      const previous = JSON.parse(fs.readFileSync(path.join(screenshotsDir, 'viewport-report.json'), 'utf8'));
      viewportResults.unshift(...previous.filter((item) => !item.native));
    }
    fs.writeFileSync(path.join(screenshotsDir, 'viewport-report.json'), JSON.stringify(viewportResults, null, 2) + '\n');
  } finally {
    for (const child of activeChildren) {
      terminateChild(child);
    }
    try {
      await appServer.stop();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  for (const child of activeChildren) {
    terminateChild(child);
  }
  console.error(err);
  process.exit(1);
});
