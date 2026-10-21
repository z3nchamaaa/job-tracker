"use strict";

require("./runtime.cjs").assertSupportedRuntime();

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const {
  SELECTION_STATUSES,
  STEP_STATUSES,
  EVENT_TYPES,
  isSelectionStatus,
  isStepStatus,
} = require("../shared/constants.cjs");
const { isCompanyPriority } = require("../shared/company-priority.cjs");
const { validateSafeHttpUrl } = require("../shared/company-draft.cjs");
const { eventInput, EventInputError } = require("../shared/event-input.cjs");
const {
  CareerProfileStore,
  DEFAULT_CAREER_PROFILE,
  normalizeCareerProfile,
} = require("./career-profile-store.cjs");

const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MiB
const MAX_STRING_LEN = 20000;
const MAX_NAME_LEN = 200;

class DatabaseValidationError extends Error {}
class DatabaseCorruptionError extends Error {}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS AppMetadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS Company (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  industry TEXT,
  jobType TEXT,
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'APPLIED',
  isEarlySelection INTEGER NOT NULL DEFAULT 0,
  websiteUrl TEXT,
  myPageUrl TEXT,
  myPageId TEXT,
  description TEXT,
  features TEXT,
  location TEXT,
  salary TEXT,
  benefits TEXT,
  ratingSalary INTEGER NOT NULL DEFAULT 0,
  ratingBenefits INTEGER NOT NULL DEFAULT 0,
  startingSalary INTEGER,
  bonusTimes INTEGER,
  bonusMonths REAL,
  annualIncome INTEGER,
  annualHolidays INTEGER,
  fixedOvertime TEXT,
  housingAllowance TEXT,
  remoteWork TEXT,
  memo TEXT,
  aiExtractedJson TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS SelectionStep (
  id TEXT PRIMARY KEY NOT NULL,
  companyId TEXT NOT NULL,
  stepName TEXT NOT NULL,
  stepOrder INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  dueDate TEXT,
  location TEXT,
  memo TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (companyId) REFERENCES Company(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS InterviewNote (
  id TEXT PRIMARY KEY NOT NULL,
  companyId TEXT NOT NULL,
  stepName TEXT NOT NULL,
  interviewDate TEXT,
  interviewer TEXT,
  questions TEXT,
  answers TEXT,
  feedback TEXT,
  nextAction TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (companyId) REFERENCES Company(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ScheduleEvent (
  id TEXT PRIMARY KEY NOT NULL,
  companyId TEXT,
  stepId TEXT,
  title TEXT NOT NULL,
  eventType TEXT NOT NULL DEFAULT 'INTERVIEW',
  startAt TEXT NOT NULL,
  endAt TEXT,
  allDay INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  memo TEXT,
  isDone INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (companyId) REFERENCES Company(id) ON DELETE CASCADE,
  FOREIGN KEY (stepId) REFERENCES SelectionStep(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_step_company ON SelectionStep(companyId, stepOrder);
CREATE INDEX IF NOT EXISTS idx_interview_company ON InterviewNote(companyId, interviewDate);
CREATE INDEX IF NOT EXISTS idx_event_company ON ScheduleEvent(companyId, startAt);
CREATE INDEX IF NOT EXISTS idx_event_start ON ScheduleEvent(startAt);
`;

function toIsoDateOrNull(val, fieldLabel = "日時") {
  if (val === undefined || val === null || val === "") return null;
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) throw new DatabaseValidationError(`${fieldLabel}が不正です。`);
    return val.toISOString();
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) throw new DatabaseValidationError(`${fieldLabel}が不正です。`);
    return d.toISOString();
  }
  if (typeof val === "string") {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) throw new DatabaseValidationError(`${fieldLabel}が不正です。`);
    return d.toISOString();
  }
  throw new DatabaseValidationError(`${fieldLabel}の形式が不正です。`);
}

function parseOptionalInt(val, label, min = 0, max = 100000000) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "boolean") throw new DatabaseValidationError(`${label}は整数で指定してください。`);
  const num = typeof val === "number" ? val : Number(val);
  if (typeof val === "string" && !/^-?\d+$/.test(val.trim())) {
    throw new DatabaseValidationError(`${label}は整数で指定してください。`);
  }
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < min || num > max) {
    throw new DatabaseValidationError(`${label}は${min}〜${max}の整数で指定してください。`);
  }
  return num;
}

function parseOptionalFloat(val, label, min = 0, max = 1000) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "boolean") throw new DatabaseValidationError(`${label}は数値で指定してください。`);
  const num = typeof val === "number" ? val : Number(val);
  if (typeof val === "string" && !/^-?\d+(\.\d+)?$/.test(val.trim())) {
    throw new DatabaseValidationError(`${label}は数値で指定してください。`);
  }
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new DatabaseValidationError(`${label}は${min}〜${max}の数値で指定してください。`);
  }
  return num;
}

function parseOptionalString(val, label, maxLen = MAX_STRING_LEN) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val !== "string") {
    throw new DatabaseValidationError(`${label}は文字列で指定してください。`);
  }
  if (val.length > maxLen) {
    throw new DatabaseValidationError(`${label}は${maxLen}文字以内で指定してください。`);
  }
  return val;
}

function parseOptionalUrl(val, label) {
  if (val === undefined || val === null || val === "") return null;
  try {
    return validateSafeHttpUrl(val, label, true);
  } catch (err) {
    throw new DatabaseValidationError(err.message);
  }
}

class DatabaseStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    if (!this.dataDir || typeof this.dataDir !== "string") {
      throw new Error("dataDir is required");
    }
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.dbPath = options.dbPath || path.join(this.dataDir, "job-tracker.db");
    this.backupDir = path.join(this.dataDir, "backups");
    this.tmpDir = path.join(this.dataDir, "tmp");
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    this.profileStore = options.profileStore || new CareerProfileStore(this.dataDir);

    this.fileIO = options.fileIO || fs;
    this.recoveryPath = path.join(this.dataDir, "import-recovery.json");
    this.recovering = false;
    this.db = null;
    this.corruptionError = null;
    this._init();
    this.recoveryError = null;
    if (this.db) {
      try { this._recoverPendingImport(); } catch (error) { this.recoveryError = error.message; }
    }
  }

  _init() {
    const exists = fs.existsSync(this.dbPath);
    if (exists) {
      const stat = fs.statSync(this.dbPath);
      if (stat.size > 0) {
        // Check header magic bytes ("SQLite format 3\0")
        const fd = fs.openSync(this.dbPath, "r");
        const header = Buffer.alloc(16);
        const bytesRead = fs.readSync(fd, header, 0, 16, 0);
        fs.closeSync(fd);
        if (bytesRead < 16 || header.toString("utf8", 0, 15) !== "SQLite format 3") {
          this.corruptionError =
            "データベースファイルが破損しています（SQLiteヘッダー不正）。データの消失を防ぐため、勝手な初期化は行っていません。バックアップからの復元、または破損ファイルの退避・再作成を実行してください。";
          return;
        }
      }
    }

    try {
      const db = new DatabaseSync(this.dbPath);
      db.exec("PRAGMA foreign_keys = ON;");
      const integrity = db.prepare("PRAGMA integrity_check;").get();
      if (!integrity || integrity.integrity_check !== "ok") {
        db.close();
        this.corruptionError =
          "データベースの整合性検査（integrity_check）に失敗しました。勝手に初期化せず保護しています。";
        return;
      }

      if (exists && fs.statSync(this.dbPath).size > 0) {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((r) => r.name);
        // If file had tables but is missing core Company table, treat as corrupt/incompatible
        if (tables.length > 0 && !tables.includes("Company")) {
          db.close();
          this.corruptionError =
            "データベースに必要なテーブル（Company）が存在しません。破損または別形式のファイルのため保護しています。";
          return;
        }
      }

      db.exec(SCHEMA_SQL);
      const eventCols = db
        .prepare("PRAGMA table_info(ScheduleEvent)")
        .all()
        .map((c) => c.name);
      if (!eventCols.includes("allDay")) {
        db.exec("ALTER TABLE ScheduleEvent ADD COLUMN allDay INTEGER NOT NULL DEFAULT 0;");
      }
      this.db = db;
      this.corruptionError = null;
    } catch (err) {
      this.db = null;
      this.corruptionError =
        "データベースファイルを開けませんでした（破損の可能性があります）。勝手に初期化せず保護しています。";
    }
  }

  // File changes are journaled before SQLite begins. A marker committed in the same
  // SQLite transaction distinguishes committed imports from interrupted ones.
  _atomicImportFile(filePath, bytes) {
    const io = this.fileIO;
    const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      io.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
      // Windows FlushFileBuffers requires write access. Keep the completed
      // contents intact and flush them before publishing with rename.
      const fd = io.openSync(temp, "r+");
      try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
      io.renameSync(temp, filePath);
    } finally {
      if (io.existsSync(temp)) io.unlinkSync(temp);
    }
  }

  _recoverPendingImport() {
    if (!this.db || this.recovering || !this.fileIO.existsSync(this.recoveryPath)) return;
    this.recovering = true;
    try {
      const journal = JSON.parse(this.fileIO.readFileSync(this.recoveryPath, "utf8"));
      if (journal.version !== 1 || typeof journal.id !== "string" ||
          !/^[0-9a-f-]{36}$/.test(journal.id) ||
          ![journal.profile, journal.snapshot].every((v) => v === null || typeof v === "string")) {
        throw new Error("Invalid import journal");
      }
      const committed = this.db.prepare("SELECT value FROM AppMetadata WHERE key = ?").get("last-import-id");
      if (!committed || committed.value !== journal.id) {
        const targets = [
          [this.profileStore.filePath, journal.profile],
          [path.join(this.backupDir, "pre-import-latest.json"), journal.snapshot],
        ];
        for (const [target, before] of targets) {
          if (before === null) {
            if (this.fileIO.existsSync(target)) this.fileIO.unlinkSync(target);
          } else {
            this._atomicImportFile(target, Buffer.from(before, "base64"));
          }
        }
      }
      this.fileIO.unlinkSync(this.recoveryPath);
      this.recoveryError = null;
    } catch (error) {
      this.recoveryError = "取り込みの復旧が完了していません。";
      throw new DatabaseCorruptionError(
        "取り込みの復旧が完了していません。元の状態と復旧記録は保持されています。保存先の権限・空き容量を確認し、再起動して再試行してください。"
      );
    } finally {
      this.recovering = false;
    }
  }

  _requireHealthy() {
    if (!this.importInProgress) this._recoverPendingImport();
    if (this.corruptionError || !this.db) {
      throw new DatabaseCorruptionError(
        this.corruptionError || "データベースが利用できない状態です。"
      );
    }
  }

  getStatus() {
    return {
      healthy: !this.corruptionError && !this.recoveryError && Boolean(this.db),
      corruptionError: this.corruptionError || this.recoveryError,
      dbPath: this.dbPath,
      hasPreImportSnapshot: fs.existsSync(path.join(this.backupDir, "pre-import-latest.json")),
    };
  }

  /**
   * ユーザーが明示的に破損DBの退避と新規再作成を選択した場合のみ実行する。
   * 元の破損ファイルは削除せず backups/ へ退避する。
   */
  recoverCorruptDatabase() {
    if (this.fileIO.existsSync(this.recoveryPath)) {
      if (!this.db) throw new DatabaseCorruptionError("取り込み復旧記録があります。DBを退避・初期化せず、保存先の状態を確認してください。");
      this._recoverPendingImport();
      this.recoveryError = null;
      return { recovered: true, archivedCorruptFile: null };
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
    let backupFile = null;
    if (fs.existsSync(this.dbPath)) {
      backupFile = path.join(this.backupDir, `corrupt-${Date.now()}.db`);
      fs.copyFileSync(this.dbPath, backupFile);
      fs.unlinkSync(this.dbPath);
    }
    this.corruptionError = null;
    this._init();
    this._requireHealthy();
    return { recovered: true, archivedCorruptFile: backupFile ? path.basename(backupFile) : null };
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }

  _inTransaction(fn) {
    this._requireHealthy();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw err;
    }
  }

  _hydrateCompany(row) {
    if (!row) return null;
    const steps = this.db
      .prepare("SELECT * FROM SelectionStep WHERE companyId = ? ORDER BY stepOrder ASC, createdAt ASC")
      .all(row.id)
      .map((s) => ({ ...s }));
    const interviews = this.db
      .prepare("SELECT * FROM InterviewNote WHERE companyId = ? ORDER BY interviewDate DESC, createdAt DESC")
      .all(row.id)
      .map((i) => ({ ...i }));
    const events = this.db
      .prepare("SELECT * FROM ScheduleEvent WHERE companyId = ? ORDER BY startAt ASC")
      .all(row.id)
      .map((e) => ({
        ...e,
        allDay: Boolean(e.allDay),
        isDone: Boolean(e.isDone),
        company: { id: row.id, name: row.name, status: row.status },
      }));

    return {
      ...row,
      isEarlySelection: Boolean(row.isEarlySelection),
      steps,
      interviews,
      events,
    };
  }

  listCompanies() {
    this._requireHealthy();
    const rows = this.db
      .prepare("SELECT * FROM Company ORDER BY priority DESC, updatedAt DESC")
      .all();
    return rows.map((r) => this._hydrateCompany(r));
  }

  getCompany(id) {
    this._requireHealthy();
    if (typeof id !== "string" || !id) return null;
    const row = this.db.prepare("SELECT * FROM Company WHERE id = ?").get(id);
    return this._hydrateCompany(row);
  }

  getCompanyDeletionImpact(id) {
    this._requireHealthy();
    const company = this.db.prepare("SELECT id, name FROM Company WHERE id = ?").get(id);
    if (!company) return null;
    const stepsCount = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM SelectionStep WHERE companyId = ?")
      .get(id).cnt;
    const interviewsCount = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM InterviewNote WHERE companyId = ?")
      .get(id).cnt;
    const eventsCount = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM ScheduleEvent WHERE companyId = ?")
      .get(id).cnt;
    return {
      id: company.id,
      name: company.name,
      stepsCount: Number(stepsCount),
      interviewsCount: Number(interviewsCount),
      eventsCount: Number(eventsCount),
    };
  }

  createCompany(body) {
    this._requireHealthy();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DatabaseValidationError("入力データを確認してください。");
    }
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    if (!rawName) {
      throw new DatabaseValidationError("企業名は必須です。");
    }
    if (rawName.length > MAX_NAME_LEN) {
      throw new DatabaseValidationError(`企業名は${MAX_NAME_LEN}文字以内で指定してください。`);
    }

    const status = body.status === undefined ? "APPLIED" : body.status;
    if (!isSelectionStatus(status)) {
      throw new DatabaseValidationError("有効な選考ステータスを指定してください。");
    }

    const priority = body.priority === undefined ? 3 : Number(body.priority);
    if (!isCompanyPriority(priority)) {
      throw new DatabaseValidationError("志望度は1〜5の整数で指定してください。");
    }

    const ratingSalary =
      body.ratingSalary === undefined || body.ratingSalary === null
        ? 0
        : parseOptionalInt(body.ratingSalary, "給与評価", 0, 5);
    const ratingBenefits =
      body.ratingBenefits === undefined || body.ratingBenefits === null
        ? 0
        : parseOptionalInt(body.ratingBenefits, "福利厚生評価", 0, 5);

    const websiteUrl = parseOptionalUrl(body.websiteUrl, "公式サイトURL");
    const myPageUrl = parseOptionalUrl(body.myPageUrl, "マイページURL");

    const now = new Date().toISOString();
    const companyId = crypto.randomUUID();

    const stepsInput = Array.isArray(body.steps) ? body.steps : [];
    const validatedSteps = stepsInput.map((s, idx) => {
      if (!s || typeof s !== "object") {
        throw new DatabaseValidationError("選考ステップの形式が不正です。");
      }
      const stepName = typeof s.stepName === "string" ? s.stepName.trim() : "";
      if (!stepName) {
        throw new DatabaseValidationError("選考ステップ名は必須です。");
      }
      if (stepName.length > MAX_NAME_LEN) {
        throw new DatabaseValidationError(`選考ステップ名は${MAX_NAME_LEN}文字以内にしてください。`);
      }
      const stepStatus = s.status || "PENDING";
      if (!isStepStatus(stepStatus)) {
        throw new DatabaseValidationError("選考ステップの状態が不正です。");
      }
      const stepOrder =
        s.stepOrder !== undefined && s.stepOrder !== null
          ? parseOptionalInt(s.stepOrder, "選考ステップ順", 0, 1000)
          : idx + 1;
      return {
        id: crypto.randomUUID(),
        stepName,
        stepOrder,
        status: stepStatus,
        dueDate: toIsoDateOrNull(s.dueDate, "ステップ期限"),
        location: parseOptionalString(s.location, "ステップ場所", 2000),
        memo: parseOptionalString(s.memo, "ステップメモ"),
      };
    });

    const record = {
      id: companyId,
      name: rawName,
      industry: parseOptionalString(body.industry, "業界", 200),
      jobType: parseOptionalString(body.jobType, "職種", 200),
      priority,
      status,
      isEarlySelection: body.isEarlySelection ? 1 : 0,
      websiteUrl,
      myPageUrl,
      myPageId: parseOptionalString(body.myPageId, "マイページID", 500),
      description: parseOptionalString(body.description, "企業概要"),
      features: parseOptionalString(body.features, "特徴"),
      location: parseOptionalString(body.location, "勤務地", 1000),
      salary: parseOptionalString(body.salary, "給与メモ"),
      benefits: parseOptionalString(body.benefits, "福利厚生メモ"),
      ratingSalary,
      ratingBenefits,
      startingSalary: parseOptionalInt(body.startingSalary, "初任給（月額・円）", 0, 10000000),
      bonusTimes: parseOptionalInt(body.bonusTimes, "賞与回数", 0, 12),
      bonusMonths: parseOptionalFloat(body.bonusMonths, "賞与月数", 0, 24),
      annualIncome: parseOptionalInt(body.annualIncome, "想定年収（万円）", 0, 100000),
      annualHolidays: parseOptionalInt(body.annualHolidays, "年間休日（日）", 0, 366),
      fixedOvertime: parseOptionalString(body.fixedOvertime, "みなし残業", 2000),
      housingAllowance: parseOptionalString(body.housingAllowance, "住宅手当・社宅", 2000),
      remoteWork: parseOptionalString(body.remoteWork, "リモートワーク", 2000),
      memo: parseOptionalString(body.memo, "企業メモ"),
      aiExtractedJson:
        body.aiExtractedJson === undefined || body.aiExtractedJson === null
          ? null
          : typeof body.aiExtractedJson === "string"
          ? body.aiExtractedJson
          : JSON.stringify(body.aiExtractedJson),
      createdAt: now,
      updatedAt: now,
    };

    this._inTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO Company (
            id, name, industry, jobType, priority, status, isEarlySelection,
            websiteUrl, myPageUrl, myPageId, description, features, location,
            salary, benefits, ratingSalary, ratingBenefits,
            startingSalary, bonusTimes, bonusMonths, annualIncome, annualHolidays,
            fixedOvertime, housingAllowance, remoteWork, memo, aiExtractedJson,
            createdAt, updatedAt
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?
          )`
        )
        .run(
          record.id,
          record.name,
          record.industry,
          record.jobType,
          record.priority,
          record.status,
          record.isEarlySelection,
          record.websiteUrl,
          record.myPageUrl,
          record.myPageId,
          record.description,
          record.features,
          record.location,
          record.salary,
          record.benefits,
          record.ratingSalary,
          record.ratingBenefits,
          record.startingSalary,
          record.bonusTimes,
          record.bonusMonths,
          record.annualIncome,
          record.annualHolidays,
          record.fixedOvertime,
          record.housingAllowance,
          record.remoteWork,
          record.memo,
          record.aiExtractedJson,
          record.createdAt,
          record.updatedAt
        );

      const stepStmt = this.db.prepare(
        `INSERT INTO SelectionStep (
          id, companyId, stepName, stepOrder, status, dueDate, location, memo, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const s of validatedSteps) {
        stepStmt.run(
          s.id,
          companyId,
          s.stepName,
          s.stepOrder,
          s.status,
          s.dueDate,
          s.location,
          s.memo,
          now,
          now
        );
      }
    });

    return this.getCompany(companyId);
  }

  updateCompany(id, body) {
    this._requireHealthy();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DatabaseValidationError("更新データを確認してください。");
    }
    const existing = this.db.prepare("SELECT * FROM Company WHERE id = ?").get(id);
    if (!existing) return null;

    const updates = [];
    const params = [];

    if ("name" in body) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) throw new DatabaseValidationError("企業名は必須です。");
      if (name.length > MAX_NAME_LEN) {
        throw new DatabaseValidationError(`企業名は${MAX_NAME_LEN}文字以内で指定してください。`);
      }
      updates.push("name = ?");
      params.push(name);
    }

    if ("status" in body) {
      if (!isSelectionStatus(body.status)) {
        throw new DatabaseValidationError("有効な選考ステータスを指定してください。");
      }
      updates.push("status = ?");
      params.push(body.status);
    }

    if ("priority" in body) {
      if (!isCompanyPriority(body.priority)) {
        throw new DatabaseValidationError("志望度は1〜5の整数で指定してください。");
      }
      updates.push("priority = ?");
      params.push(body.priority);
    }

    if ("isEarlySelection" in body) {
      updates.push("isEarlySelection = ?");
      params.push(body.isEarlySelection ? 1 : 0);
    }

    if ("websiteUrl" in body) {
      updates.push("websiteUrl = ?");
      params.push(parseOptionalUrl(body.websiteUrl, "公式サイトURL"));
    }

    if ("myPageUrl" in body) {
      updates.push("myPageUrl = ?");
      params.push(parseOptionalUrl(body.myPageUrl, "マイページURL"));
    }

    const stringFields = [
      ["industry", "業界", 200],
      ["jobType", "職種", 200],
      ["myPageId", "マイページID", 500],
      ["description", "企業概要", MAX_STRING_LEN],
      ["features", "特徴", MAX_STRING_LEN],
      ["location", "勤務地", 1000],
      ["salary", "給与メモ", MAX_STRING_LEN],
      ["benefits", "福利厚生メモ", MAX_STRING_LEN],
      ["fixedOvertime", "みなし残業", 2000],
      ["housingAllowance", "住宅手当・社宅", 2000],
      ["remoteWork", "リモートワーク", 2000],
      ["memo", "企業メモ", MAX_STRING_LEN],
    ];

    for (const [field, label, maxLen] of stringFields) {
      if (field in body) {
        updates.push(`${field} = ?`);
        params.push(parseOptionalString(body[field], label, maxLen));
      }
    }

    if ("ratingSalary" in body) {
      const val =
        body.ratingSalary === null || body.ratingSalary === ""
          ? 0
          : parseOptionalInt(body.ratingSalary, "給与評価", 0, 5);
      updates.push("ratingSalary = ?");
      params.push(val);
    }

    if ("ratingBenefits" in body) {
      const val =
        body.ratingBenefits === null || body.ratingBenefits === ""
          ? 0
          : parseOptionalInt(body.ratingBenefits, "福利厚生評価", 0, 5);
      updates.push("ratingBenefits = ?");
      params.push(val);
    }

    if ("startingSalary" in body) {
      updates.push("startingSalary = ?");
      params.push(parseOptionalInt(body.startingSalary, "初任給（月額・円）", 0, 10000000));
    }

    if ("bonusTimes" in body) {
      updates.push("bonusTimes = ?");
      params.push(parseOptionalInt(body.bonusTimes, "賞与回数", 0, 12));
    }

    if ("bonusMonths" in body) {
      updates.push("bonusMonths = ?");
      params.push(parseOptionalFloat(body.bonusMonths, "賞与月数", 0, 24));
    }

    if ("annualIncome" in body) {
      updates.push("annualIncome = ?");
      params.push(parseOptionalInt(body.annualIncome, "想定年収（万円）", 0, 100000));
    }

    if ("annualHolidays" in body) {
      updates.push("annualHolidays = ?");
      params.push(parseOptionalInt(body.annualHolidays, "年間休日（日）", 0, 366));
    }

    if (updates.length > 0) {
      updates.push("updatedAt = ?");
      params.push(new Date().toISOString());
      params.push(id);
      this.db.prepare(`UPDATE Company SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }

    return this.getCompany(id);
  }

  deleteCompany(id) {
    this._requireHealthy();
    const impact = this.getCompanyDeletionImpact(id);
    if (!impact) return null;
    this._inTransaction(() => {
      this.db.prepare("DELETE FROM Company WHERE id = ?").run(id);
    });
    return impact;
  }

  createStep(body) {
    this._requireHealthy();
    if (!body || typeof body !== "object") {
      throw new DatabaseValidationError("入力内容を確認してください。");
    }
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    if (!companyId || !this.db.prepare("SELECT id FROM Company WHERE id = ?").get(companyId)) {
      throw new DatabaseValidationError("関連する企業が見つかりません。");
    }
    const stepName = typeof body.stepName === "string" ? body.stepName.trim() : "";
    if (!stepName) {
      throw new DatabaseValidationError("選考ステップ名を入力してください。");
    }
    if (stepName.length > MAX_NAME_LEN) {
      throw new DatabaseValidationError(`選考ステップ名は${MAX_NAME_LEN}文字以内にしてください。`);
    }
    const status = body.status || "PENDING";
    if (!isStepStatus(status)) {
      throw new DatabaseValidationError("選考ステップの状態が不正です。");
    }
    const maxOrderRow = this.db
      .prepare("SELECT COALESCE(MAX(stepOrder), 0) AS maxOrder FROM SelectionStep WHERE companyId = ?")
      .get(companyId);
    const stepOrder =
      body.stepOrder !== undefined && body.stepOrder !== null
        ? parseOptionalInt(body.stepOrder, "順番", 0, 1000)
        : Number(maxOrderRow.maxOrder) + 1;
    const dueDate = toIsoDateOrNull(body.dueDate, "期限");
    const location = parseOptionalString(body.location, "場所", 2000);
    const memo = parseOptionalString(body.memo, "メモ");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO SelectionStep (
          id, companyId, stepName, stepOrder, status, dueDate, location, memo, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, companyId, stepName, stepOrder, status, dueDate, location, memo, now, now);

    return this.db.prepare("SELECT * FROM SelectionStep WHERE id = ?").get(id);
  }

  updateStep(id, body) {
    this._requireHealthy();
    if (!body || typeof body !== "object") {
      throw new DatabaseValidationError("入力内容を確認してください。");
    }
    const existing = this.db.prepare("SELECT * FROM SelectionStep WHERE id = ?").get(id);
    if (!existing) return null;

    const updates = [];
    const params = [];

    if ("stepName" in body) {
      const name = typeof body.stepName === "string" ? body.stepName.trim() : "";
      if (!name) throw new DatabaseValidationError("選考ステップ名は必須です。");
      if (name.length > MAX_NAME_LEN) {
        throw new DatabaseValidationError(`選考ステップ名は${MAX_NAME_LEN}文字以内にしてください。`);
      }
      updates.push("stepName = ?");
      params.push(name);
    }
    if ("stepOrder" in body) {
      updates.push("stepOrder = ?");
      params.push(parseOptionalInt(body.stepOrder, "順番", 0, 1000));
    }
    if ("status" in body) {
      if (!isStepStatus(body.status)) {
        throw new DatabaseValidationError("選考ステップの状態が不正です。");
      }
      updates.push("status = ?");
      params.push(body.status);
    }
    if ("dueDate" in body) {
      updates.push("dueDate = ?");
      params.push(toIsoDateOrNull(body.dueDate, "期限"));
    }
    if ("location" in body) {
      updates.push("location = ?");
      params.push(parseOptionalString(body.location, "場所", 2000));
    }
    if ("memo" in body) {
      updates.push("memo = ?");
      params.push(parseOptionalString(body.memo, "メモ"));
    }

    if (updates.length > 0) {
      updates.push("updatedAt = ?");
      params.push(new Date().toISOString());
      params.push(id);
      this.db.prepare(`UPDATE SelectionStep SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }

    return this.db.prepare("SELECT * FROM SelectionStep WHERE id = ?").get(id);
  }

  deleteStep(id) {
    this._requireHealthy();
    const existing = this.db.prepare("SELECT * FROM SelectionStep WHERE id = ?").get(id);
    if (!existing) return false;
    this.db.prepare("DELETE FROM SelectionStep WHERE id = ?").run(id);
    return true;
  }

  createInterviewNote(body) {
    this._requireHealthy();
    if (!body || typeof body !== "object") {
      throw new DatabaseValidationError("入力内容を確認してください。");
    }
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    const stepName = typeof body.stepName === "string" ? body.stepName.trim() : "";
    if (!companyId || !stepName) {
      throw new DatabaseValidationError("企業IDと面接段階名は必須です。");
    }
    if (!this.db.prepare("SELECT id FROM Company WHERE id = ?").get(companyId)) {
      throw new DatabaseValidationError("関連する企業が見つかりません。");
    }
    if (stepName.length > MAX_NAME_LEN) {
      throw new DatabaseValidationError(`面接段階名は${MAX_NAME_LEN}文字以内にしてください。`);
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const interviewDate = body.interviewDate
      ? toIsoDateOrNull(body.interviewDate, "面接日時")
      : now;

    this.db
      .prepare(
        `INSERT INTO InterviewNote (
          id, companyId, stepName, interviewDate, interviewer, questions, answers, feedback, nextAction, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        companyId,
        stepName,
        interviewDate,
        parseOptionalString(body.interviewer, "面接官", 1000),
        parseOptionalString(body.questions, "質問"),
        parseOptionalString(body.answers, "回答"),
        parseOptionalString(body.feedback, "振り返り"),
        parseOptionalString(body.nextAction, "次の行動"),
        now,
        now
      );

    return this.db.prepare("SELECT * FROM InterviewNote WHERE id = ?").get(id);
  }

  updateInterviewNote(id, body) {
    this._requireHealthy();
    if (!body || typeof body !== "object") {
      throw new DatabaseValidationError("入力内容を確認してください。");
    }
    const existing = this.db.prepare("SELECT * FROM InterviewNote WHERE id = ?").get(id);
    if (!existing) return null;

    const updates = [];
    const params = [];

    if ("stepName" in body) {
      const stepName = typeof body.stepName === "string" ? body.stepName.trim() : "";
      if (!stepName) throw new DatabaseValidationError("面接段階名は必須です。");
      updates.push("stepName = ?");
      params.push(stepName);
    }
    if ("interviewDate" in body) {
      updates.push("interviewDate = ?");
      params.push(toIsoDateOrNull(body.interviewDate, "面接日時"));
    }
    for (const [field, label, maxLen] of [
      ["interviewer", "面接官", 1000],
      ["questions", "質問", MAX_STRING_LEN],
      ["answers", "回答", MAX_STRING_LEN],
      ["feedback", "振り返り", MAX_STRING_LEN],
      ["nextAction", "次の行動", MAX_STRING_LEN],
    ]) {
      if (field in body) {
        updates.push(`${field} = ?`);
        params.push(parseOptionalString(body[field], label, maxLen));
      }
    }

    if (updates.length > 0) {
      updates.push("updatedAt = ?");
      params.push(new Date().toISOString());
      params.push(id);
      this.db.prepare(`UPDATE InterviewNote SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }

    return this.db.prepare("SELECT * FROM InterviewNote WHERE id = ?").get(id);
  }

  deleteInterviewNote(id) {
    this._requireHealthy();
    const existing = this.db.prepare("SELECT * FROM InterviewNote WHERE id = ?").get(id);
    if (!existing) return false;
    this.db.prepare("DELETE FROM InterviewNote WHERE id = ?").run(id);
    return true;
  }

  listEvents() {
    this._requireHealthy();
    const rows = this.db
      .prepare(
        `SELECT e.*, c.name AS companyName, c.status AS companyStatus, s.stepName AS stepName
         FROM ScheduleEvent e
         LEFT JOIN Company c ON e.companyId = c.id
         LEFT JOIN SelectionStep s ON e.stepId = s.id
         ORDER BY e.startAt ASC`
      )
      .all();

    return rows.map((r) => {
      const { companyName, companyStatus, stepName, ...rest } = r;
      return {
        ...rest,
        allDay: Boolean(rest.allDay),
        isDone: Boolean(rest.isDone),
        stepName: stepName || null,
        company: rest.companyId && companyName
          ? { id: rest.companyId, name: companyName, status: companyStatus }
          : null,
      };
    });
  }

  createEvent(body) {
    this._requireHealthy();
    const validated = eventInput(body);
    const { companyId, stepId } = body || {};

    for (const value of [companyId, stepId]) {
      if (value !== undefined && value !== null && value !== "" && typeof value !== "string") {
        throw new EventInputError("関連する企業・選考を確認してください。");
      }
    }

    const normalizedCompanyId = companyId ? companyId : null;
    const normalizedStepId = stepId ? stepId : null;

    if (normalizedCompanyId) {
      const comp = this.db.prepare("SELECT id FROM Company WHERE id = ?").get(normalizedCompanyId);
      if (!comp) throw new EventInputError("関連する企業が見つかりません。");
    }

    if (normalizedStepId) {
      const step = this.db
        .prepare("SELECT id, companyId FROM SelectionStep WHERE id = ?")
        .get(normalizedStepId);
      if (!step || step.companyId !== normalizedCompanyId) {
        throw new EventInputError("選考と企業の組み合わせを確認してください。");
      }
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const startAtIso = validated.startAt.toISOString();
    const endAtIso = validated.endAt ? validated.endAt.toISOString() : null;

    this.db
      .prepare(
        `INSERT INTO ScheduleEvent (
          id, companyId, stepId, title, eventType, startAt, endAt, allDay, location, memo, isDone, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        normalizedCompanyId,
        normalizedStepId,
        validated.title,
        validated.eventType || "INTERVIEW",
        startAtIso,
        endAtIso,
        validated.allDay ? 1 : 0,
        validated.location ?? null,
        validated.memo ?? null,
        validated.isDone ? 1 : 0,
        now,
        now
      );

    return this.listEvents().find((e) => e.id === id);
  }

  updateEvent(id, body) {
    this._requireHealthy();
    const current = this.db.prepare("SELECT * FROM ScheduleEvent WHERE id = ?").get(id);
    if (!current) return null;

    const validated = eventInput(body, {
      startAt: new Date(current.startAt),
      endAt: current.endAt ? new Date(current.endAt) : null,
    });

    const updates = [];
    const params = [];

    if ("companyId" in body || "stepId" in body) {
      const nextCompanyId =
        "companyId" in body ? (body.companyId ? body.companyId : null) : current.companyId;
      const nextStepId =
        "stepId" in body ? (body.stepId ? body.stepId : null) : current.stepId;

      if (nextCompanyId) {
        const comp = this.db.prepare("SELECT id FROM Company WHERE id = ?").get(nextCompanyId);
        if (!comp) throw new EventInputError("関連する企業が見つかりません。");
      }
      if (nextStepId) {
        const step = this.db
          .prepare("SELECT id, companyId FROM SelectionStep WHERE id = ?")
          .get(nextStepId);
        if (!step || step.companyId !== nextCompanyId) {
          throw new EventInputError("選考と企業の組み合わせを確認してください。");
        }
      }
      updates.push("companyId = ?", "stepId = ?");
      params.push(nextCompanyId, nextStepId);
    }

    if ("title" in validated) {
      updates.push("title = ?");
      params.push(validated.title);
    }
    if ("eventType" in validated) {
      updates.push("eventType = ?");
      params.push(validated.eventType);
    }
    if ("startAt" in validated) {
      updates.push("startAt = ?");
      params.push(validated.startAt.toISOString());
    }
    if ("endAt" in validated) {
      updates.push("endAt = ?");
      params.push(validated.endAt ? validated.endAt.toISOString() : null);
    }
    if ("allDay" in validated) {
      updates.push("allDay = ?");
      params.push(validated.allDay ? 1 : 0);
    }
    if ("location" in validated) {
      updates.push("location = ?");
      params.push(validated.location);
    }
    if ("memo" in validated) {
      updates.push("memo = ?");
      params.push(validated.memo);
    }
    if ("isDone" in validated) {
      updates.push("isDone = ?");
      params.push(validated.isDone ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push("updatedAt = ?");
      params.push(new Date().toISOString());
      params.push(id);
      this.db.prepare(`UPDATE ScheduleEvent SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }

    return this.listEvents().find((e) => e.id === id);
  }

  deleteEvent(id) {
    this._requireHealthy();
    const existing = this.db.prepare("SELECT id FROM ScheduleEvent WHERE id = ?").get(id);
    if (!existing) return false;
    this.db.prepare("DELETE FROM ScheduleEvent WHERE id = ?").run(id);
    return true;
  }

  /**
   * 現在のDB内容（および就活プロフィール）をJSON形式でエクスポートする。
   * 秘密情報・個人メモが含まれる場合は警告メタデータを付与する。
   */
  exportBackup(careerProfile = undefined) {
    this._requireHealthy();
    const companies = this.db.prepare("SELECT * FROM Company ORDER BY createdAt ASC").all();
    const steps = this.db.prepare("SELECT * FROM SelectionStep ORDER BY stepOrder ASC").all();
    const interviews = this.db.prepare("SELECT * FROM InterviewNote ORDER BY createdAt ASC").all();
    const events = this.db.prepare("SELECT * FROM ScheduleEvent ORDER BY startAt ASC").all();

    let resolvedProfile = null;
    if (careerProfile !== undefined && careerProfile !== null) {
      resolvedProfile = normalizeCareerProfile({
        ...DEFAULT_CAREER_PROFILE,
        ...careerProfile,
      });
    } else if (careerProfile === undefined && this.profileStore) {
      try {
        resolvedProfile = this.profileStore.getProfile();
      } catch {
        resolvedProfile = null;
      }
    }

    const hasProfileContent = Boolean(
      resolvedProfile &&
        (resolvedProfile.major ||
          resolvedProfile.industries ||
          resolvedProfile.roles ||
          resolvedProfile.priorities ||
          resolvedProfile.strengths)
    );

    const containsSensitiveInfo =
      companies.some((c) => Boolean(c.myPageId) || Boolean(c.memo)) ||
      interviews.length > 0 ||
      hasProfileContent;

    return {
      format: "job-tracker-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      securityNotice:
        "このバックアップにはマイページID、選考メモ、面接記録、就活プロフィールなどの個人データが含まれます。認証トークンやパスワードは含まれません。ファイルの保管場所にご注意ください。",
      containsSensitiveInfo,
      counts: {
        companies: companies.length,
        steps: steps.length,
        interviews: interviews.length,
        events: events.length,
        careerProfile: resolvedProfile ? 1 : 0,
      },
      data: {
        companies: companies.map((c) => ({
          ...c,
          isEarlySelection: Boolean(c.isEarlySelection),
        })),
        steps: steps.map((s) => ({ ...s })),
        interviews: interviews.map((i) => ({ ...i })),
        events: events.map((e) => ({
          ...e,
          allDay: Boolean(e.allDay),
          isDone: Boolean(e.isDone),
        })),
        careerProfile: resolvedProfile,
      },
    };
  }

  /**
   * 旧版SQLiteデータ(base64)またはJSONバックアップをコピー上で検証し、
   * 件数・項目・就活プロフィール・除外される秘密情報フィールドのプレビューを返す。
   * この段階では現在のDBやプロフィールを一切変更しない。
   * セキュリティ境界としてローカルファイルパス指定(sqlite_file / filePath)は拒否する。
   */
  previewImport(source) {
    this._requireHealthy();
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new DatabaseValidationError("取り込みデータを確認してください。");
    }

    if (
      source.kind === "sqlite_file" ||
      "filePath" in source ||
      "path" in source ||
      (source.payload &&
        typeof source.payload === "object" &&
        ("filePath" in source.payload || source.payload.kind === "sqlite_file"))
    ) {
      throw new DatabaseValidationError(
        "セキュリティ制限によりローカルファイルパスの直接指定は許可されていません。ファイル選択からデータを取り込んでください。"
      );
    }

    if (source.kind === "sqlite_base64") {
      return this._previewSqliteImport(source);
    }
    if (source.kind === "json") {
      return this._previewJsonImport(source.payload);
    }
    throw new DatabaseValidationError(
      "対応していない取り込み形式です（SQLite .db または JSON バックアップを指定してください）。"
    );
  }

  _previewSqliteImport(source) {
    const tmpFile = path.join(this.tmpDir, `import-verify-${crypto.randomUUID()}.db`);
    try {
      if (typeof source.base64 !== "string" || !source.base64) {
        throw new DatabaseValidationError("ファイルデータが空です。");
      }
      const buf = Buffer.from(source.base64, "base64");
      if (buf.length < 100 || buf.length > MAX_IMPORT_BYTES) {
        throw new DatabaseValidationError("ファイルサイズが不正または上限（50MB）を超えています。");
      }
      if (buf.toString("utf8", 0, 15) !== "SQLite format 3") {
        throw new DatabaseValidationError("有効なSQLiteデータベースファイルではありません。");
      }
      fs.writeFileSync(tmpFile, buf, { mode: 0o600 });

      let copyDb;
      try {
        copyDb = new DatabaseSync(tmpFile, { readOnly: true });
        const integrity = copyDb.prepare("PRAGMA integrity_check;").get();
        if (!integrity || integrity.integrity_check !== "ok") {
          throw new DatabaseValidationError("取り込み元SQLiteファイルの整合性チェックに失敗しました。");
        }

        const tables = new Set(
          copyDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((r) => r.name)
        );
        for (const reqTable of ["Company", "SelectionStep", "InterviewNote", "ScheduleEvent"]) {
          if (!tables.has(reqTable)) {
            throw new DatabaseValidationError(
              `取り込み元DBに必要なテーブル（${reqTable}）が存在しません。`
            );
          }
        }

        const rawCompanies = copyDb.prepare("SELECT * FROM Company").all();
        const rawSteps = copyDb.prepare("SELECT * FROM SelectionStep").all();
        const rawInterviews = copyDb.prepare("SELECT * FROM InterviewNote").all();
        const rawEvents = copyDb.prepare("SELECT * FROM ScheduleEvent").all();

        return this._validateNormalizedImportData(
          {
            companies: rawCompanies,
            steps: rawSteps,
            interviews: rawInterviews,
            events: rawEvents,
            careerProfile: null,
          },
          "sqlite"
        );
      } finally {
        if (copyDb) {
          try {
            copyDb.close();
          } catch {}
        }
      }
    } finally {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {}
    }
  }

  _previewJsonImport(payload) {
    let parsed = payload;
    if (typeof payload === "string") {
      if (payload.length > MAX_IMPORT_BYTES) {
        throw new DatabaseValidationError("JSONデータが上限サイズを超えています。");
      }
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new DatabaseValidationError("JSONの形式が不正です。");
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DatabaseValidationError("バックアップデータの形式が不正です。");
    }
    const container = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    if (!Array.isArray(container.companies)) {
      throw new DatabaseValidationError("バックアップデータに companies 配列が含まれていません。");
    }
    const hasCareerProfileKey = Object.prototype.hasOwnProperty.call(container, "careerProfile");
    return this._validateNormalizedImportData(
      {
        companies: container.companies,
        steps: Array.isArray(container.steps) ? container.steps : [],
        interviews: Array.isArray(container.interviews) ? container.interviews : [],
        events: Array.isArray(container.events) ? container.events : [],
        careerProfile: hasCareerProfileKey ? container.careerProfile : undefined,
      },
      "json"
    );
  }

  _validateNormalizedImportData(raw, sourceType) {
    const nowIso = new Date().toISOString();
    const strippedFields = new Set();
    const companyIds = new Set();
    const stepMap = new Map();

    let normalizedCareerProfile = null;
    if (raw.careerProfile !== undefined && raw.careerProfile !== null) {
      try {
        normalizedCareerProfile = normalizeCareerProfile(raw.careerProfile);
      } catch (err) {
        throw new DatabaseValidationError(
          `バックアップ内の就活プロフィールが不正です: ${err.message}`
        );
      }
    }

    const companies = raw.companies.map((c, idx) => {
      if (!c || typeof c !== "object") {
        throw new DatabaseValidationError(`企業データ(${idx + 1}件目)が不正です。`);
      }
      if ("myPagePassword" in c && c.myPagePassword) {
        strippedFields.add("myPagePassword");
      }
      for (const forbidden of ["access_token", "refresh_token", "id_token", "authToken"]) {
        if (forbidden in c) strippedFields.add(forbidden);
      }

      const id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : crypto.randomUUID();
      if (companyIds.has(id)) {
        throw new DatabaseValidationError(`企業ID(${id})が重複しています。`);
      }
      const name = typeof c.name === "string" ? c.name.trim() : "";
      if (!name || name.length > MAX_NAME_LEN) {
        throw new DatabaseValidationError(`企業名(${idx + 1}件目)が不正です。`);
      }
      const status = c.status || "APPLIED";
      if (!isSelectionStatus(status)) {
        throw new DatabaseValidationError(`企業「${name}」のステータス(${status})が不正です。`);
      }
      const priority = c.priority === undefined || c.priority === null ? 3 : Number(c.priority);
      if (!isCompanyPriority(priority)) {
        throw new DatabaseValidationError(`企業「${name}」の志望度(${c.priority})が不正です。`);
      }

      companyIds.add(id);

      return {
        id,
        name,
        industry: parseOptionalString(c.industry, "業界", 200),
        jobType: parseOptionalString(c.jobType, "職種", 200),
        priority,
        status,
        isEarlySelection: c.isEarlySelection ? 1 : 0,
        websiteUrl: parseOptionalUrl(c.websiteUrl, "公式サイトURL"),
        myPageUrl: parseOptionalUrl(c.myPageUrl, "マイページURL"),
        myPageId: parseOptionalString(c.myPageId, "マイページID", 500),
        description: parseOptionalString(c.description, "企業概要"),
        features: parseOptionalString(c.features, "特徴"),
        location: parseOptionalString(c.location, "勤務地", 1000),
        salary: parseOptionalString(c.salary, "給与メモ"),
        benefits: parseOptionalString(c.benefits, "福利厚生メモ"),
        ratingSalary:
          c.ratingSalary === undefined || c.ratingSalary === null
            ? 0
            : parseOptionalInt(c.ratingSalary, "給与評価", 0, 5),
        ratingBenefits:
          c.ratingBenefits === undefined || c.ratingBenefits === null
            ? 0
            : parseOptionalInt(c.ratingBenefits, "福利厚生評価", 0, 5),
        startingSalary: parseOptionalInt(c.startingSalary, "初任給", 0, 10000000),
        bonusTimes: parseOptionalInt(c.bonusTimes, "賞与回数", 0, 12),
        bonusMonths: parseOptionalFloat(c.bonusMonths, "賞与月数", 0, 24),
        annualIncome: parseOptionalInt(c.annualIncome, "想定年収", 0, 100000),
        annualHolidays: parseOptionalInt(c.annualHolidays, "年間休日", 0, 366),
        fixedOvertime: parseOptionalString(c.fixedOvertime, "みなし残業", 2000),
        housingAllowance: parseOptionalString(c.housingAllowance, "住宅手当", 2000),
        remoteWork: parseOptionalString(c.remoteWork, "リモートワーク", 2000),
        memo: parseOptionalString(c.memo, "メモ"),
        aiExtractedJson: parseOptionalString(c.aiExtractedJson, "AI抽出データ", 200000),
        createdAt: toIsoDateOrNull(c.createdAt, "作成日時") || nowIso,
        updatedAt: toIsoDateOrNull(c.updatedAt, "更新日時") || nowIso,
      };
    });

    const steps = raw.steps.map((s, idx) => {
      if (!s || typeof s !== "object") {
        throw new DatabaseValidationError(`選考ステップ(${idx + 1}件目)が不正です。`);
      }
      const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : crypto.randomUUID();
      if (!companyIds.has(s.companyId)) {
        throw new DatabaseValidationError(
          `選考ステップ(${idx + 1}件目)の参照先企業IDが存在しません。`
        );
      }
      const stepName = typeof s.stepName === "string" ? s.stepName.trim() : "";
      if (!stepName || stepName.length > MAX_NAME_LEN) {
        throw new DatabaseValidationError(`選考ステップ名(${idx + 1}件目)が不正です。`);
      }
      const status = s.status || "PENDING";
      if (!isStepStatus(status)) {
        throw new DatabaseValidationError(`選考ステップ状態(${status})が不正です。`);
      }
      stepMap.set(id, s.companyId);
      return {
        id,
        companyId: s.companyId,
        stepName,
        stepOrder:
          s.stepOrder !== undefined && s.stepOrder !== null
            ? parseOptionalInt(s.stepOrder, "ステップ順序", 0, 1000)
            : idx + 1,
        status,
        dueDate: toIsoDateOrNull(s.dueDate, "期限"),
        location: parseOptionalString(s.location, "場所", 2000),
        memo: parseOptionalString(s.memo, "メモ"),
        createdAt: toIsoDateOrNull(s.createdAt, "作成日時") || nowIso,
        updatedAt: toIsoDateOrNull(s.updatedAt, "更新日時") || nowIso,
      };
    });

    const interviews = raw.interviews.map((i, idx) => {
      if (!i || typeof i !== "object") {
        throw new DatabaseValidationError(`面接記録(${idx + 1}件目)が不正です。`);
      }
      if (!companyIds.has(i.companyId)) {
        throw new DatabaseValidationError(`面接記録(${idx + 1}件目)の参照先企業IDが存在しません。`);
      }
      const stepName = typeof i.stepName === "string" ? i.stepName.trim() : "";
      if (!stepName) {
        throw new DatabaseValidationError(`面接記録(${idx + 1}件目)の段階名が空です。`);
      }
      return {
        id: typeof i.id === "string" && i.id.trim() ? i.id.trim() : crypto.randomUUID(),
        companyId: i.companyId,
        stepName,
        interviewDate: toIsoDateOrNull(i.interviewDate, "面接日時") || nowIso,
        interviewer: parseOptionalString(i.interviewer, "面接官", 1000),
        questions: parseOptionalString(i.questions, "質問"),
        answers: parseOptionalString(i.answers, "回答"),
        feedback: parseOptionalString(i.feedback, "振り返り"),
        nextAction: parseOptionalString(i.nextAction, "次の行動"),
        createdAt: toIsoDateOrNull(i.createdAt, "作成日時") || nowIso,
        updatedAt: toIsoDateOrNull(i.updatedAt, "更新日時") || nowIso,
      };
    });

    const events = raw.events.map((e, idx) => {
      if (!e || typeof e !== "object") {
        throw new DatabaseValidationError(`予定(${idx + 1}件目)が不正です。`);
      }
      const companyId = e.companyId ? e.companyId : null;
      if (companyId && !companyIds.has(companyId)) {
        throw new DatabaseValidationError(`予定(${idx + 1}件目)の参照先企業IDが存在しません。`);
      }
      const stepId = e.stepId ? e.stepId : null;
      if (stepId && (!stepMap.has(stepId) || stepMap.get(stepId) !== companyId)) {
        throw new DatabaseValidationError(`予定(${idx + 1}件目)の参照先ステップIDが不正です。`);
      }
      const title = typeof e.title === "string" ? e.title.trim() : "";
      if (!title) {
        throw new DatabaseValidationError(`予定(${idx + 1}件目)のタイトルが空です。`);
      }
      const eventType = e.eventType || "INTERVIEW";
      if (!EVENT_TYPES.includes(eventType)) {
        throw new DatabaseValidationError(`予定(${idx + 1}件目)の種別(${eventType})が不正です。`);
      }
      const startAt = toIsoDateOrNull(e.startAt, "開始日時");
      if (!startAt) {
        throw new DatabaseValidationError(`予定(${idx + 1}件目)の開始日時が必要です。`);
      }
      const endAt = toIsoDateOrNull(e.endAt, "終了日時");
      if (endAt && new Date(endAt) <= new Date(startAt)) {
        throw new DatabaseValidationError(
          `予定「${title}」の終了日時が開始日時以前になっています。`
        );
      }
      return {
        id: typeof e.id === "string" && e.id.trim() ? e.id.trim() : crypto.randomUUID(),
        companyId,
        stepId,
        title,
        eventType,
        startAt,
        endAt,
        allDay: e.allDay ? 1 : 0,
        location: parseOptionalString(e.location, "場所", 2000),
        memo: parseOptionalString(e.memo, "メモ"),
        isDone: e.isDone ? 1 : 0,
        createdAt: toIsoDateOrNull(e.createdAt, "作成日時") || nowIso,
        updatedAt: toIsoDateOrNull(e.updatedAt, "更新日時") || nowIso,
      };
    });

    return {
      valid: true,
      sourceType,
      hasCareerProfile: Boolean(normalizedCareerProfile),
      careerProfileSummary: normalizedCareerProfile
        ? {
            completed: normalizedCareerProfile.completed,
            major: normalizedCareerProfile.major,
            industries: normalizedCareerProfile.industries,
            roles: normalizedCareerProfile.roles,
          }
        : null,
      counts: {
        companies: companies.length,
        steps: steps.length,
        interviews: interviews.length,
        events: events.length,
        careerProfile: normalizedCareerProfile ? 1 : 0,
      },
      strippedFields: ["myPagePassword", "authTokens", ...strippedFields],
      sampleCompanies: companies.slice(0, 10).map((c) => ({
        id: c.id,
        name: c.name,
        industry: c.industry,
        status: c.status,
        priority: c.priority,
      })),
      normalizedData: {
        companies,
        steps,
        interviews,
        events,
        careerProfile: normalizedCareerProfile,
      },
    };
  }

  /**
   * 検証済みのデータをトランザクションで取り込む。
   * 実行前に現在のDB状態と就活プロフィールをスナップショットとして保持し、
   * トランザクションとプロフィール保存の両方が成功した場合のみ pre-import-latest.json を更新する。
   * 途中で1件でもエラー（またはプロフィール保存失敗）が発生した場合は ROLLBACK し、
   * 一部だけ取り込まれた状態を残さず、前回の有効な rollback スナップショットも上書きしない。
   */
  executeImport(source, mode = "replace", options = {}) {
    this._requireHealthy();
    if (mode !== "replace" && mode !== "merge") {
      throw new DatabaseValidationError("取り込みモードが不正です（replace または merge）。");
    }

    const preview = this.previewImport(source);
    const { companies, steps, interviews, events, careerProfile } = preview.normalizedData;

    // 現在のプロフィールを取得（破損している場合はインポート開始前にエラーとして停止）
    let currentProfile = { ...DEFAULT_CAREER_PROFILE };
    let hadProfileFile = false;
    if (this.profileStore) {
      hadProfileFile = fs.existsSync(this.profileStore.filePath);
      currentProfile = this.profileStore.getProfile();
    }

    // 取り込み前のスナップショットをメモリ上で構築（まだディスク上の pre-import-latest.json は上書きしない）
    const candidateSnapshot = this.exportBackup(currentProfile);
    candidateSnapshot.hadProfileFile = hadProfileFile;

    // 適用すべきプロフィールの決定
    let nextProfileToSave = null;
    let shouldRemoveProfileFile = false;
    if (options._isRollback && options._hadProfileFile === false) {
      shouldRemoveProfileFile = true;
    } else if (careerProfile) {
      if (mode === "replace") {
        nextProfileToSave = careerProfile;
      } else {
        nextProfileToSave = normalizeCareerProfile({
          version: 1,
          completed: Boolean(currentProfile.completed || careerProfile.completed),
          major: careerProfile.major || currentProfile.major || "",
          industries: careerProfile.industries || currentProfile.industries || "",
          roles: careerProfile.roles || currentProfile.roles || "",
          priorities: careerProfile.priorities || currentProfile.priorities || "",
          strengths: careerProfile.strengths || currentProfile.strengths || "",
        });
      }
    }

    const snapshotPath = path.join(this.backupDir, "pre-import-latest.json");
    const readBefore = (p) => this.fileIO.existsSync(p)
      ? this.fileIO.readFileSync(p).toString("base64") : null;
    const importId = crypto.randomUUID();
    this._atomicImportFile(this.recoveryPath, JSON.stringify({
      version: 1, id: importId,
      profile: readBefore(this.profileStore.filePath),
      snapshot: readBefore(snapshotPath),
    }));
    this.importInProgress = true;
    try {
      this._inTransaction(() => {
        if (mode === "replace") {
          this.db.prepare("DELETE FROM ScheduleEvent").run();
          this.db.prepare("DELETE FROM InterviewNote").run();
          this.db.prepare("DELETE FROM SelectionStep").run();
          this.db.prepare("DELETE FROM Company").run();
        }

        const companyVerb = "INSERT INTO";
        const prepareImport = (sql) => {
          if (mode === "merge") {
            const columns = /\(([\s\S]*?)\)\s*VALUES/.exec(sql)[1].split(",").map((c) => c.trim()).filter((c) => c !== "id");
            sql += " ON CONFLICT(id) DO UPDATE SET " + columns.map((c) => `${c}=excluded.${c}`).join(",");
          }
          return this.db.prepare(sql);
        };
        const insertCompany = prepareImport(
          `${companyVerb} Company (
            id, name, industry, jobType, priority, status, isEarlySelection,
            websiteUrl, myPageUrl, myPageId, description, features, location,
            salary, benefits, ratingSalary, ratingBenefits,
            startingSalary, bonusTimes, bonusMonths, annualIncome, annualHolidays,
            fixedOvertime, housingAllowance, remoteWork, memo, aiExtractedJson,
            createdAt, updatedAt
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?
          )`
        );

        for (const c of companies) {
          insertCompany.run(
            c.id,
            c.name,
            c.industry,
            c.jobType,
            c.priority,
            c.status,
            c.isEarlySelection,
            c.websiteUrl,
            c.myPageUrl,
            c.myPageId,
            c.description,
            c.features,
            c.location,
            c.salary,
            c.benefits,
            c.ratingSalary,
            c.ratingBenefits,
            c.startingSalary,
            c.bonusTimes,
            c.bonusMonths,
            c.annualIncome,
            c.annualHolidays,
            c.fixedOvertime,
            c.housingAllowance,
            c.remoteWork,
            c.memo,
            c.aiExtractedJson,
            c.createdAt,
            c.updatedAt
          );
        }

        const insertStep = prepareImport(
          `${companyVerb} SelectionStep (
            id, companyId, stepName, stepOrder, status, dueDate, location, memo, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const s of steps) {
          insertStep.run(
            s.id,
            s.companyId,
            s.stepName,
            s.stepOrder,
            s.status,
            s.dueDate,
            s.location,
            s.memo,
            s.createdAt,
            s.updatedAt
          );
        }

        const insertInterview = prepareImport(
          `${companyVerb} InterviewNote (
            id, companyId, stepName, interviewDate, interviewer, questions, answers, feedback, nextAction, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const i of interviews) {
          insertInterview.run(
            i.id,
            i.companyId,
            i.stepName,
            i.interviewDate,
            i.interviewer,
            i.questions,
            i.answers,
            i.feedback,
            i.nextAction,
            i.createdAt,
            i.updatedAt
          );
        }

        const insertEvent = prepareImport(
          `${companyVerb} ScheduleEvent (
            id, companyId, stepId, title, eventType, startAt, endAt, allDay, location, memo, isDone, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const e of events) {
          insertEvent.run(
            e.id,
            e.companyId,
            e.stepId,
            e.title,
            e.eventType,
            e.startAt,
            e.endAt,
            e.allDay,
            e.location,
            e.memo,
            e.isDone,
            e.createdAt,
            e.updatedAt
          );
        }

        // トランザクションCOMMIT直前にプロフィールを保存（失敗時は例外でSQLite側もROLLBACKされる）
        if (this.profileStore) {
          if (nextProfileToSave) {
            this.profileStore.saveProfile(nextProfileToSave);

          } else if (shouldRemoveProfileFile && fs.existsSync(this.profileStore.filePath)) {
            fs.unlinkSync(this.profileStore.filePath);

          }
        }
        if (!options._isRollback) {
          this._atomicImportFile(snapshotPath, JSON.stringify(candidateSnapshot, null, 2));
        }
        this.db.prepare("INSERT OR REPLACE INTO AppMetadata(key, value) VALUES (?, ?)")
          .run("last-import-id", importId);
      });
    } catch (error) {
      // SQLite has already rolled back; restore files even if a save mutated then threw.
      // Recovery errors deliberately propagate and retain the journal for the next start.
      this._recoverPendingImport();
      throw error;
    } finally {
      this.importInProgress = false;
    }
    // A cleanup failure after commit is recoverable, and must not report a false failure.
    try { this.fileIO.unlinkSync(this.recoveryPath); } catch {}

    return {
      imported: true,
      hasCareerProfile: preview.hasCareerProfile,
      profileRestored: Boolean(nextProfileToSave),
      counts: preview.counts,
      strippedFields: preview.strippedFields,
      canRollback: true,
    };
  }

  /**
   * 取り込み前の自動退避スナップショットから元のDBおよび就活プロフィール状態へ復元する。
   */
  rollbackLastImport() {
    this._requireHealthy();
    const snapshotPath = path.join(this.backupDir, "pre-import-latest.json");
    if (!fs.existsSync(snapshotPath)) {
      throw new DatabaseValidationError("復元可能な取り込み前スナップショットが見つかりません。");
    }
    const content = fs.readFileSync(snapshotPath, "utf8");
    let parsedSnapshot = null;
    try {
      parsedSnapshot = JSON.parse(content);
    } catch {
      throw new DatabaseValidationError("取り込み前スナップショットが破損しています。");
    }
    const result = this.executeImport(
      { kind: "json", payload: parsedSnapshot },
      "replace",
      {
        _isRollback: true,
        _hadProfileFile: parsedSnapshot.hadProfileFile,
      }
    );
    return {
      rolledBack: true,
      hasCareerProfile: result.hasCareerProfile,
      counts: result.counts,
    };
  }
}

module.exports = {
  DatabaseStore,
  DatabaseValidationError,
  DatabaseCorruptionError,
};
