import { DatabaseSync } from 'node:sqlite';

export type Admission = { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number };
/** Atomic exact rolling window with conservative token reservations. */
export class TokenLimiter {
  private readonly db: DatabaseSync;
  constructor(path: string, public readonly capacity: number, public readonly windowMs = 60_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('Invalid limiter configuration');
    this.db = new DatabaseSync(path);
    try {
    this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS rate_config (id INTEGER PRIMARY KEY CHECK(id=1), capacity INTEGER NOT NULL, window_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_clock (id INTEGER PRIMARY KEY CHECK(id=1), time INTEGER NOT NULL);
      INSERT OR IGNORE INTO rate_clock VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, time INTEGER NOT NULL, tokens INTEGER NOT NULL CHECK(tokens>0));
      CREATE INDEX IF NOT EXISTS reservations_subject_time ON reservations(subject,time);
      CREATE INDEX IF NOT EXISTS reservations_time ON reservations(time);`);
    this.db.prepare('INSERT OR IGNORE INTO rate_config VALUES (1, ?, ?)').run(capacity, windowMs);
    const config = this.db.prepare('SELECT capacity, window_ms FROM rate_config WHERE id=1').get();
    if (config?.capacity !== capacity || config.window_ms !== windowMs) throw new Error('Shared database limiter configuration mismatch');
    } catch (error) { this.db.close(); throw error; }
  }
  consume(subject: string, tokens: number, time = Date.now()): Admission {
    if (!subject || subject.length > 256 || !Number.isSafeInteger(tokens) || tokens < 1 || !Number.isSafeInteger(time) || time < 0) throw new Error('Invalid reservation');
    if (tokens > this.capacity) return { allowed: false, retryAfterMs: this.windowMs };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const clock = this.db.prepare('SELECT time FROM rate_clock WHERE id=1').get()!;
      const now = Math.max(time, Number(clock.time));
      this.db.prepare('UPDATE rate_clock SET time=? WHERE id=1').run(now);
      this.db.prepare('DELETE FROM reservations WHERE time<=?').run(now - this.windowMs);
      const rows = this.db.prepare('SELECT time, tokens FROM reservations WHERE subject=? ORDER BY time,id').all(subject);
      let used = rows.reduce((sum, row) => sum + Number(row.tokens), 0);
      let result: Admission;
      if (used + tokens <= this.capacity) {
        this.db.prepare('INSERT INTO reservations(subject,time,tokens) VALUES (?,?,?)').run(subject, now, tokens);
        result = { allowed: true, remaining: this.capacity - used - tokens };
      } else {
        let retry = this.windowMs;
        for (const row of rows) {
          used -= Number(row.tokens);
          if (used + tokens <= this.capacity) { retry = Number(row.time) + this.windowMs - now; break; }
        }
        result = { allowed: false, retryAfterMs: retry };
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
