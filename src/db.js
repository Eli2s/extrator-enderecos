import Database from "better-sqlite3";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "saas.db");

let _db = null;

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
    seedPlans(_db);
  }
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT   NOT NULL,
      name         TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      id            TEXT    PRIMARY KEY,
      name          TEXT    NOT NULL,
      price_brl     REAL    NOT NULL,
      credits       INTEGER,
      duration_days INTEGER
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      plan_id           TEXT    NOT NULL REFERENCES plans(id),
      expires_at        TEXT,
      credits_remaining INTEGER,
      status            TEXT    NOT NULL DEFAULT 'active',
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      plan_id        TEXT    NOT NULL REFERENCES plans(id),
      mp_payment_id  TEXT,
      amount_brl     REAL    NOT NULL,
      status         TEXT    NOT NULL DEFAULT 'pending',
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      subscription_id INTEGER REFERENCES subscriptions(id),
      filename        TEXT,
      extracted_count INTEGER NOT NULL DEFAULT 0,
      used_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

const PLANS = [
  { id: "avulso_1",  name: "1 Extração",  price_brl: 2.90,  credits: 1,    duration_days: null },
  { id: "avulso_5",  name: "5 Extrações", price_brl: 9.90,  credits: 5,    duration_days: null },
  { id: "semanal",   name: "Semanal",     price_brl: 9.90,  credits: null, duration_days: 7    },
  { id: "mensal",    name: "Mensal",      price_brl: 29.90, credits: null, duration_days: 30   },
];

function seedPlans(db) {
  const upsert = db.prepare(`
    INSERT INTO plans (id, name, price_brl, credits, duration_days)
    VALUES (@id, @name, @price_brl, @credits, @duration_days)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      price_brl = excluded.price_brl,
      credits = excluded.credits,
      duration_days = excluded.duration_days
  `);
  for (const plan of PLANS) {
    upsert.run(plan);
  }
}

export function getPlans() {
  return getDb().prepare("SELECT * FROM plans ORDER BY price_brl").all();
}

export function getPlanById(id) {
  return getDb().prepare("SELECT * FROM plans WHERE id = ?").get(id);
}

export function getActiveSubscription(userId) {
  return getDb().prepare(`
    SELECT s.*, p.name AS plan_name, p.credits AS plan_credits, p.duration_days
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.user_id = ?
      AND s.status = 'active'
      AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
      AND (s.credits_remaining IS NULL OR s.credits_remaining > 0)
    ORDER BY s.id DESC
    LIMIT 1
  `).get(userId);
}

export function activateSubscription(userId, planId) {
  const plan = getPlanById(planId);
  if (!plan) throw new Error("Plano não encontrado");

  const expiresAt = plan.duration_days
    ? new Date(Date.now() + plan.duration_days * 86400000).toISOString().slice(0, 19).replace("T", " ")
    : null;

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO subscriptions (user_id, plan_id, expires_at, credits_remaining, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(userId, planId, expiresAt, plan.credits);

  return result.lastInsertRowid;
}

export function consumeCredit(userId, subId) {
  getDb().prepare(`
    UPDATE subscriptions
    SET credits_remaining = credits_remaining - 1
    WHERE id = ? AND user_id = ? AND credits_remaining > 0
  `).run(subId, userId);
}

export function logUsage(userId, subId, filename, extractedCount) {
  getDb().prepare(`
    INSERT INTO usage_logs (user_id, subscription_id, filename, extracted_count)
    VALUES (?, ?, ?, ?)
  `).run(userId, subId, filename, extractedCount);
}

export function getUsageLogs(userId, limit = 20) {
  return getDb().prepare(`
    SELECT ul.*, p.name AS plan_name
    FROM usage_logs ul
    LEFT JOIN subscriptions s ON s.id = ul.subscription_id
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE ul.user_id = ?
    ORDER BY ul.used_at DESC
    LIMIT ?
  `).all(userId, limit);
}

export function createTransaction(userId, planId, amountBrl, mpPaymentId = null) {
  const result = getDb().prepare(`
    INSERT INTO transactions (user_id, plan_id, mp_payment_id, amount_brl, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(userId, planId, mpPaymentId, amountBrl);
  return result.lastInsertRowid;
}

export function approveTransaction(txId, mpPaymentId = null) {
  const db = getDb();
  const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId);
  if (!tx) throw new Error("Transação não encontrada");

  db.prepare(`
    UPDATE transactions SET status = 'approved', mp_payment_id = COALESCE(?, mp_payment_id)
    WHERE id = ?
  `).run(mpPaymentId, txId);

  return activateSubscription(tx.user_id, tx.plan_id);
}
