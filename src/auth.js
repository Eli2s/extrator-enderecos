import bcrypt from "bcryptjs";
import { getDb } from "./db.js";

const SALT_ROUNDS = 10;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function createUser(email, plainPassword, name = "") {
  const hash = await hashPassword(plainPassword);
  const db = getDb();
  try {
    const result = db.prepare(
      "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)"
    ).run(email.toLowerCase().trim(), hash, name.trim());
    return getUserById(result.lastInsertRowid);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw Object.assign(new Error("E-mail já cadastrado."), { status: 409 });
    }
    throw err;
  }
}

export async function loginUser(email, plainPassword) {
  const db = getDb();
  const user = db.prepare(
    "SELECT * FROM users WHERE email = ?"
  ).get(email.toLowerCase().trim());

  if (!user) throw Object.assign(new Error("Credenciais inválidas."), { status: 401 });

  const ok = await verifyPassword(plainPassword, user.password_hash);
  if (!ok) throw Object.assign(new Error("Credenciais inválidas."), { status: 401 });

  return safeUser(user);
}

export function getUserById(id) {
  const user = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
  return user ? safeUser(user) : null;
}

function safeUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

export function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.accepts("html")) return res.redirect("/login");
  return res.status(401).json({ ok: false, erro: "Login necessário." });
}

export function requirePlan(req, res, next) {
  next(); // actual credit check happens inside /extrair with user-friendly messaging
}
