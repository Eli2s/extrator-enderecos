import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

const {
  DB_HOST,
  DB_PORT = "3306",
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
} = process.env;

let pool = null;
let initPromise = null;

const PLANS = [
  { id: "avulso_1", name: "1 Extração", price_brl: 2.9, credits: 1, duration_days: null },
  { id: "avulso_5", name: "5 Extrações", price_brl: 9.9, credits: 5, duration_days: null },
  { id: "semanal", name: "Semanal", price_brl: 9.9, credits: null, duration_days: 7 },
  { id: "mensal", name: "Mensal", price_brl: 29.9, credits: null, duration_days: 30 },
];

function assertEnv() {
  const missing = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"].filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Banco MySQL não configurado. Defina: ${missing.join(", ")}`);
  }
}

function normalizeRow(row) {
  if (!row) return row;
  return {
    ...row,
    price_brl: row.price_brl !== undefined && row.price_brl !== null ? Number(row.price_brl) : row.price_brl,
    amount_brl: row.amount_brl !== undefined && row.amount_brl !== null ? Number(row.amount_brl) : row.amount_brl,
    credits: row.credits !== undefined && row.credits !== null ? Number(row.credits) : row.credits,
    duration_days: row.duration_days !== undefined && row.duration_days !== null ? Number(row.duration_days) : row.duration_days,
    credits_remaining: row.credits_remaining !== undefined && row.credits_remaining !== null ? Number(row.credits_remaining) : row.credits_remaining,
    extracted_count: row.extracted_count !== undefined && row.extracted_count !== null ? Number(row.extracted_count) : row.extracted_count,
  };
}

async function initSchema(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(191) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(191) NOT NULL DEFAULT '',
      is_admin TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Migration: add is_admin to pre-existing databases
  try {
    await conn.query(`ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err) {
    if (err.code !== "ER_DUP_FIELDNAME") throw err;
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      name VARCHAR(191) NOT NULL,
      price_brl DECIMAL(10,2) NOT NULL,
      credits INT NULL,
      duration_days INT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      plan_id VARCHAR(64) NOT NULL,
      expires_at DATETIME NULL,
      credits_remaining INT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
      KEY idx_subscriptions_user_status (user_id, status, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      plan_id VARCHAR(64) NOT NULL,
      mp_payment_id VARCHAR(191) NULL,
      amount_brl DECIMAL(10,2) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_transactions_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      subscription_id BIGINT UNSIGNED NULL,
      filename VARCHAR(255) NULL,
      extracted_count INT NOT NULL DEFAULT 0,
      used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_usage_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
      KEY idx_usage_user_date (user_id, used_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const plan of PLANS) {
    await conn.query(
      `INSERT INTO plans (id, name, price_brl, credits, duration_days)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         price_brl = VALUES(price_brl),
         credits = VALUES(credits),
         duration_days = VALUES(duration_days)`,
      [plan.id, plan.name, plan.price_brl, plan.credits, plan.duration_days]
    );
  }

  // Seed admin user
  const adminHash = await bcrypt.hash("Adm@2025!", 10);
  await conn.query(
    `INSERT INTO users (email, password_hash, name, is_admin)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE is_admin = 1`,
    ["eliaseugenio365@gmail.com", adminHash, "adm"]
  );
}

export async function getDb() {
  if (pool) return pool;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    assertEnv();
    pool = mysql.createPool({
      host: DB_HOST,
      port: Number(DB_PORT),
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: "utf8mb4",
    });

    const conn = await pool.getConnection();
    try {
      await initSchema(conn);
    } finally {
      conn.release();
    }

    return pool;
  })();

  return initPromise;
}

export async function getPlans() {
  const db = await getDb();
  const [rows] = await db.query("SELECT * FROM plans ORDER BY price_brl");
  return rows.map(normalizeRow);
}

export async function getPlanById(id) {
  const db = await getDb();
  const [rows] = await db.query("SELECT * FROM plans WHERE id = ? LIMIT 1", [id]);
  return normalizeRow(rows[0] || null);
}

export async function getActiveSubscription(userId) {
  const db = await getDb();
  const [rows] = await db.query(
    `SELECT s.*, p.name AS plan_name, p.credits AS plan_credits, p.duration_days
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ?
       AND s.status = 'active'
       AND (s.expires_at IS NULL OR s.expires_at > NOW())
       AND (s.credits_remaining IS NULL OR s.credits_remaining > 0)
     ORDER BY s.id DESC
     LIMIT 1`,
    [userId]
  );
  return normalizeRow(rows[0] || null);
}

export async function activateSubscription(userId, planId, conn = null) {
  const executor = conn || await getDb();
  const plan = await getPlanById(planId);
  if (!plan) throw new Error("Plano não encontrado");

  const [result] = await executor.query(
    `INSERT INTO subscriptions (user_id, plan_id, expires_at, credits_remaining, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [
      userId,
      planId,
      plan.duration_days ? new Date(Date.now() + plan.duration_days * 86400000) : null,
      plan.credits,
    ]
  );

  return result.insertId;
}

export async function consumeCredit(userId, subId) {
  const db = await getDb();
  await db.query(
    `UPDATE subscriptions
     SET credits_remaining = credits_remaining - 1
     WHERE id = ? AND user_id = ? AND credits_remaining > 0`,
    [subId, userId]
  );
}

export async function logUsage(userId, subId, filename, extractedCount) {
  const db = await getDb();
  await db.query(
    `INSERT INTO usage_logs (user_id, subscription_id, filename, extracted_count)
     VALUES (?, ?, ?, ?)`,
    [userId, subId, filename, extractedCount]
  );
}

export async function getUsageLogs(userId, limit = 20) {
  const db = await getDb();
  const [rows] = await db.query(
    `SELECT ul.*, p.name AS plan_name
     FROM usage_logs ul
     LEFT JOIN subscriptions s ON s.id = ul.subscription_id
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE ul.user_id = ?
     ORDER BY ul.used_at DESC
     LIMIT ?`,
    [userId, Number(limit)]
  );
  return rows.map(normalizeRow);
}

export async function createTransaction(userId, planId, amountBrl, mpPaymentId = null) {
  const db = await getDb();
  const [result] = await db.query(
    `INSERT INTO transactions (user_id, plan_id, mp_payment_id, amount_brl, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [userId, planId, mpPaymentId, amountBrl]
  );
  return result.insertId;
}

export async function approveTransaction(txId, mpPaymentId = null) {
  const db = await getDb();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query("SELECT * FROM transactions WHERE id = ? LIMIT 1 FOR UPDATE", [txId]);
    const tx = rows[0];
    if (!tx) throw new Error("Transação não encontrada");

    if (tx.status === "approved") {
      await conn.commit();
      return null;
    }

    await conn.query(
      `UPDATE transactions
       SET status = 'approved', mp_payment_id = COALESCE(?, mp_payment_id)
       WHERE id = ?`,
      [mpPaymentId, txId]
    );

    const subId = await activateSubscription(tx.user_id, tx.plan_id, conn);
    await conn.commit();
    return subId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
