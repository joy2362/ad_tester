import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RunRecord, RunSummary } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "runs.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      label TEXT,
      script TEXT NOT NULL,
      input_mode TEXT NOT NULL,
      resolved_type TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs (created_at DESC);
  `);
  return db;
}

export function insertRun(record: RunRecord): void {
  getDb()
    .prepare(
      `INSERT INTO runs (id, created_at, label, script, input_mode, resolved_type, options_json, status, error, result_json)
       VALUES (@id, @created_at, @label, @script, @input_mode, @resolved_type, @options_json, @status, @error, @result_json)`,
    )
    .run({
      id: record.id,
      created_at: record.createdAt,
      label: record.label,
      script: record.script,
      input_mode: record.inputMode,
      resolved_type: record.resolvedType,
      options_json: JSON.stringify(record.options),
      status: record.status,
      error: record.error,
      result_json: record.result ? JSON.stringify(record.result) : null,
    });
}

interface Row {
  id: string;
  created_at: number;
  label: string | null;
  script: string;
  input_mode: string;
  resolved_type: string;
  options_json: string;
  status: string;
  error: string | null;
  result_json: string | null;
}

function rowToRecord(row: Row): RunRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    label: row.label,
    script: row.script,
    inputMode: row.input_mode as RunRecord["inputMode"],
    resolvedType: row.resolved_type as RunRecord["resolvedType"],
    options: JSON.parse(row.options_json),
    status: row.status as RunRecord["status"],
    error: row.error,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

export function getRun(id: string): RunRecord | null {
  const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function deleteRun(id: string): boolean {
  return getDb().prepare("DELETE FROM runs WHERE id = ?").run(id).changes > 0;
}

export function listRuns(limit = 50): RunSummary[] {
  const rows = getDb()
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map((row) => {
    const record = rowToRecord(row);
    const r = record.result;
    return {
      id: record.id,
      createdAt: record.createdAt,
      label: record.label,
      resolvedType: record.resolvedType,
      status: record.status,
      requestCount: r?.metrics.requestCount ?? 0,
      totalBytes: r?.metrics.totalBytes ?? 0,
      thirdPartyDomainCount: r?.metrics.thirdPartyDomains.length ?? 0,
      consoleErrorCount: r?.metrics.consoleErrorCount ?? 0,
      failCheckCount: r?.checks.filter((c) => c.status === "fail").length ?? 0,
      warnCheckCount: r?.checks.filter((c) => c.status === "warn").length ?? 0,
      durationMs: r?.durationMs ?? 0,
    } satisfies RunSummary;
  });
}
