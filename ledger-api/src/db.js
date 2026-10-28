'use strict';

const { DatabaseSync } = require('node:sqlite');

/**
 * Schema notes
 * - Money is stored as INTEGER minor units (e.g. paise/cents) to avoid float rounding.
 * - CHECK / UNIQUE / FOREIGN KEY constraints enforce integrity even if app code is bypassed.
 * - Triggers make the transactions table append-only (no UPDATE / DELETE).
 * - `seq` is a monotonically increasing tie-breaker so "latest first" is deterministic
 *   even when two rows share the same created_at millisecond.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  balance       INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id               TEXT PRIMARY KEY,
  reference_id     TEXT NOT NULL UNIQUE CHECK (length(trim(reference_id)) > 0),
  from_account_id  TEXT NOT NULL REFERENCES accounts(id),
  to_account_id    TEXT NOT NULL REFERENCES accounts(id),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  description      TEXT,
  created_at       TEXT NOT NULL,
  CHECK (from_account_id <> to_account_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  type           TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  description    TEXT,
  reference_id   TEXT NOT NULL CHECK (length(trim(reference_id)) > 0),
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  transfer_id    TEXT REFERENCES transfers(id),
  created_at     TEXT NOT NULL,
  UNIQUE (account_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_tx_account_latest
  ON transactions (account_id, created_at DESC, seq DESC);

CREATE TRIGGER IF NOT EXISTS trg_transactions_no_update
BEFORE UPDATE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_transactions_no_delete
BEFORE DELETE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are immutable');
END;
`;

function createDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/**
 * Wraps fn in BEGIN IMMEDIATE ... COMMIT. Any thrown error rolls the whole unit back,
 * so a balance update and its ledger row are always persisted together or not at all.
 * IMMEDIATE takes SQLite's write lock up front, serialising concurrent writers.
 */
function withTransaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back on its own (e.g. RAISE(ABORT) in some cases).
      }
      throw err;
    }
  };
}

module.exports = { createDatabase, withTransaction };
