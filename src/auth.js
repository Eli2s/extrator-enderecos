import bcrypt from "bcryptjs";
import { ensureUserRole, getDb } from "./db.js";
import {
  EMAIL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isValidEmail,
  isValidPasswordLength,
  normalizeEmailAddress,
  normalizeTextInput,
} from "./validation.js";

const SALT_ROUNDS = 10;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function createUser(email, plainPassword, name = "", role = "user") {
  const normalizedEmail = normalizeEmailAddress(email);
  const normalizedName = normalizeTextInput(name, NAME_MAX_LENGTH);
  if (!normalizedName) {
    throw Object.assign(new Error("Informe seu nome."), { status: 400 });
  }
  if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
    throw Object.assign(new Error("Informe um e-mail valido."), { status: 400 });
  }
  if (!isValidPasswordLength(plainPassword)) {
    throw Object.assign(new Error(`A senha deve ter entre ${PASSWORD_MIN_LENGTH} e ${PASSWORD_MAX_LENGTH} caracteres.`), { status: 400 });
  }

  const hash = await hashPassword(plainPassword);
  const db = await getDb();

  try {
    const [result] = await db.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)",
      [normalizedEmail.slice(0, EMAIL_MAX_LENGTH), hash, normalizedName, role === "admin" ? "admin" : "user"]
    );
    return getUserById(result.insertId);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      throw Object.assign(new Error("E-mail já cadastrado."), { status: 409 });
    }
    throw err;
  }
}

export async function getUserByEmail(email) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
    return null;
  }
  const db = await getDb();
  const [rows] = await db.query(
    "SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1",
    [normalizedEmail]
  );
  const user = rows[0];
  return user ? safeUser(user) : null;
}

export async function loginUser(email, plainPassword) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
    throw Object.assign(new Error("Informe um e-mail valido."), { status: 400 });
  }
  const db = await getDb();
  const [rows] = await db.query(
    "SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1",
    [normalizedEmail]
  );
  const user = rows[0];

  if (!user) throw Object.assign(new Error("Credenciais inválidas."), { status: 401 });

  const ok = await verifyPassword(plainPassword, user.password_hash);
  if (!ok) throw Object.assign(new Error("Credenciais inválidas."), { status: 401 });

  return safeUser(user);
}

export async function getUserById(id) {
  const db = await getDb();
  const [rows] = await db.query(
    "SELECT * FROM users WHERE id = ? LIMIT 1",
    [id]
  );
  const user = rows[0];
  return user ? safeUser(user) : null;
}

export async function updateUserPassword(userId, plainPassword) {
  if (!isValidPasswordLength(plainPassword)) {
    throw Object.assign(new Error(`A senha deve ter entre ${PASSWORD_MIN_LENGTH} e ${PASSWORD_MAX_LENGTH} caracteres.`), { status: 400 });
  }
  const hash = await hashPassword(plainPassword);
  const db = await getDb();
  await db.query(
    "UPDATE users SET password_hash = ? WHERE id = ?",
    [hash, userId]
  );
}

export async function ensureAdminUser(email, plainPassword, name = "Administrador") {
  const existing = await getUserByEmail(email);
  if (!existing) {
    return createUser(email, plainPassword, name, "admin");
  }

  await updateUserPassword(existing.id, plainPassword);
  await ensureUserRole(existing.id, "admin");
  const db = await getDb();
  await db.query(
    "UPDATE users SET name = ? WHERE id = ?",
    [normalizeTextInput(name, NAME_MAX_LENGTH), existing.id]
  );
  return getUserById(existing.id);
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
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  if (req.accepts("html")) return res.status(403).redirect("/");
  return res.status(403).json({ ok: false, erro: "Acesso restrito ao administrador." });
}
