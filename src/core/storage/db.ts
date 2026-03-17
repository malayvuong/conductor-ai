import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { SCHEMA_SQL, migrateSchema } from './schema.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'conductor.db');

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA_SQL);
  migrateSchema(_db);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** For tests: create an in-memory DB */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}
