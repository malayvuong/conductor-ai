import type Database from 'better-sqlite3';
import { getRunById, getTaskById } from '../core/storage/repository.js';

export function findRunByPrefix(db: Database.Database, prefix: string): any {
  const exact = getRunById(db, prefix);
  if (exact) return exact;

  const all = db.prepare('SELECT * FROM runs WHERE id LIKE ? LIMIT 2').all(`${prefix}%`);
  if (all.length === 1) return all[0];
  if (all.length > 1) {
    console.error(`Ambiguous run ID prefix: ${prefix}. Multiple matches.`);
    process.exit(1);
  }
  return null;
}

export function findTaskByPrefix(db: Database.Database, prefix: string): any {
  const exact = getTaskById(db, prefix);
  if (exact) return exact;

  const all = db.prepare('SELECT * FROM tasks WHERE id LIKE ? LIMIT 2').all(`${prefix}%`);
  if (all.length === 1) return all[0];
  if (all.length > 1) {
    console.error(`Ambiguous task ID prefix: ${prefix}. Multiple matches.`);
    process.exit(1);
  }
  return null;
}
