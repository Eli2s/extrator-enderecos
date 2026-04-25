import dotenv from "dotenv";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import session from "express-session";
import createMySqlSession from "express-mysql-session";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { MercadoPagoConfig, Payment } from "mercadopago";

import { extractAddressesFromPdfBuffer, generateTxtBuffer } from "./src/extractor.js";
import { generateXlsxBuffer } from "./src/xlsx.js";
import {
  getDb,
  getPlans,
  getPlanById,
  getActiveSubscription,
  consumeCredit,
  logUsage,
  getUsageLogs,
  createTransaction,
  approveTransaction,
  authorizeRecurringTransaction,
  getTransactionById,
  updateTransactionStatus,
  getMysqlPoolConfig,
} from "./src/db.js";
import { createUser, getUserByEmail, loginUser, getUserById, requireAuth, updateUserPassword } from "./src/auth.js";

const runtimeEnv = process.env.NODE_ENV || "development";
dotenv.config({ path: runtimeEnv === "production" ? ".env.production" : ".env.local" });

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const MySQLStore = createMySqlSession(session);
const sessionStore = new MySQLStore(
  {
    ...getMysqlPoolConfig(),
    createDatabaseTable: true,
    schema: {
      tableName: "sessions",
      columnNames: {
        session_id: "session_id",
        expires: "expires",
        data: "data",
      },
    },
  }
);

app.disable("x-powered-by");

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleRateLimit,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: handleRateLimit,
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleRateLimit,
});

const extractorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleRateLimit,
});

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleRateLimit,
});

app.set("trust proxy", 1);
app.use(globalLimiter);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://sdk.mercadopago.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.mercadopago.com"],
      connectSrc: ["'self'", "https://api.mercadopago.com", "https://*.mercadopago.com"],
      frameSrc: ["'self'", "https://sdk.mercadopago.com", "https://*.mercadopago.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: "extrator.sid",
  secret: process.env.SESSION_SECRET || "dev-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 86400000,
  },
}));
app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Attach user to every request
app.use(async (req, res, next) => {
  try {
    if (req.session?.userId) {
      req.user = await getUserById(req.session.userId);
      if (!req.user) delete req.session.userId;
    }
    next();
  } catch (err) {
    next(err);
  }
});

app.use((req, res, next) => {
  req.csrfTokenValue = ensureCsrfToken(req);
  res.locals.csrfToken = req.csrfTokenValue;
  next();
});

// Mercado Pago
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || "";
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || "";
const MP_WEBHOOK_TOLERANCE_MS = Number(process.env.MP_WEBHOOK_TOLERANCE_MS || 5 * 60 * 1000);
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const mpClient = MP_TOKEN ? new MercadoPagoConfig({ accessToken: MP_TOKEN }) : null;
assertServerConfig();

function assertServerConfig() {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) {
    const message = "SESSION_SECRET deve ter pelo menos 32 caracteres.";
    if (isProduction) {
      throw new Error(message);
    }
    console.warn(message);
  }

  if (isProduction && !BASE_URL.startsWith("https://")) {
    throw new Error("BASE_URL deve usar HTTPS em producao.");
  }

  if (isProduction && MP_TOKEN && !MP_WEBHOOK_SECRET) {
    throw new Error("MP_WEBHOOK_SECRET deve estar configurado em producao quando Mercado Pago estiver ativo.");
  }

  if (isProduction && MP_TOKEN && !MP_PUBLIC_KEY) {
    throw new Error("MP_PUBLIC_KEY deve estar configurada em producao para checkout transparente com cartao.");
  }

  if (!isProduction && MP_TOKEN && !MP_WEBHOOK_SECRET) {
    console.warn("MP_WEBHOOK_SECRET nao configurado; em desenvolvimento o webhook sera aceito sem assinatura.");
  }
}

function handleRateLimit(req, res) {
  const message = "Muitas tentativas. Tente novamente em alguns minutos.";
  if (isApiRequest(req)) {
    return res.status(429).json({ ok: false, erro: message });
  }
  return res.status(429).type("html").send(shell("Limite excedido", `
    <div class="form-page">
      <div class="form-card">
        <h1>Limite excedido</h1>
        <p class="sub">${esc(message)}</p>
      </div>
    </div>`, req.user || null, null, req.session?.csrfToken || ""));
}

function parseMercadoPagoSignature(headerValue) {
  const parts = {};
  for (const part of String(headerValue || "").split(",")) {
    const [key, value] = part.trim().split("=");
    if (key && value) parts[key] = value;
  }
  return {
    ts: parts.ts || "",
    v1: parts.v1 || "",
  };
}

function buildMercadoPagoManifest(req) {
  const dataId = String(req.query["data.id"] || "").trim().toLowerCase();
  const requestId = String(req.get("x-request-id") || "").trim();
  const { ts } = parseMercadoPagoSignature(req.get("x-signature"));
  return {
    dataId,
    requestId,
    ts,
    manifest: `id:${dataId};request-id:${requestId};ts:${ts};`,
  };
}

function isMercadoPagoWebhookValid(req) {
  if (!MP_WEBHOOK_SECRET) {
    return !isProduction;
  }

  const { ts, v1 } = parseMercadoPagoSignature(req.get("x-signature"));
  const { dataId, requestId, manifest } = buildMercadoPagoManifest(req);
  if (!ts || !v1 || !dataId || !requestId) {
    return false;
  }

  const tsNumber = Number(ts);
  if (!Number.isFinite(tsNumber)) {
    return false;
  }

  if (Math.abs(Date.now() - tsNumber) > MP_WEBHOOK_TOLERANCE_MS) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  return safeTokenEquals(expected, v1);
}

// ── Shared CSS ────────────────────────────────────────────────────────────────
const CSS = `
  :root {
    --bg:#09090b; --s1:#111113; --s2:#18181b;
    --border:#27272a; --bh:#3f3f46;
    --t1:#fafafa; --t2:#a1a1aa; --t3:#52525b;
    --accent:#dc2626; --green:#22c55e; --red:#ef4444; --amber:#f59e0b;
    --r:10px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--t1); min-height: 100vh;
    display: flex; flex-direction: column; line-height: 1.5;
  }
  /* topbar */
  .topbar {
    height: 52px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; padding: 0 20px; gap: 12px; flex-shrink: 0;
  }
  .logo { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 14px; letter-spacing: -.01em; text-decoration: none; color: var(--t1) }
  .logo-mark {
    width: 26px; height: 26px; border-radius: 7px; background: var(--accent);
    display: grid; place-items: center; font-size: 11px; font-weight: 800; color: #fff; flex-shrink: 0;
  }
  .topbar-sep { flex: 1 }
  .topbar-link {
    font-size: 13px; color: var(--t3); padding: 5px 10px; border-radius: var(--r);
    cursor: pointer; background: none; border: none; text-decoration: none;
    transition: color .15s, background .15s;
  }
  .topbar-link:hover { color: var(--t1); background: var(--s2) }
  .topbar-cta {
    font-size: 13px; font-weight: 600; padding: 6px 14px; border-radius: var(--r);
    border: none; cursor: pointer; background: var(--accent); color: #fff;
    text-decoration: none; transition: opacity .15s;
  }
  .topbar-cta:hover { opacity: .85 }
  /* page */
  .page { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 56px 20px 80px; gap: 40px }
  /* hero */
  .hero { text-align: center; max-width: 520px }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px;
    background: rgba(220,38,38,.1); border: 1px solid rgba(220,38,38,.3);
    color: #fca5a5; font-size: 12px; font-weight: 700; letter-spacing: .05em;
    text-transform: uppercase; margin-bottom: 18px;
  }
  .hero h1 { font-size: clamp(2rem,5vw,3rem); font-weight: 800; letter-spacing: -.04em; line-height: 1.05; margin-bottom: 14px }
  .gr { background: linear-gradient(135deg,#ffffff 0%,#d4d4d4 50%,#a3a3a3 100%); -webkit-background-clip: text; background-clip: text; color: transparent }
  .hero p { font-size: 15px; color: var(--t2); line-height: 1.65 }
  /* cards */
  .card {
    width: 100%; max-width: 560px;
    background: var(--s1); border: 1px solid var(--border);
    border-radius: 16px; overflow: hidden; border-top: 2px solid var(--accent);
  }
  .card-pad { padding: 28px }
  .card h2 { font-size: 18px; font-weight: 700; margin-bottom: 6px }
  .card p { color: var(--t2); font-size: 14px }
  /* drop zone */
  .drop-zone {
    display: block; padding: 40px 28px; text-align: center; cursor: pointer;
    transition: background .15s; position: relative;
  }
  .drop-zone:hover, .drop-zone.over { background: var(--s2) }
  .drop-icon {
    width: 52px; height: 52px; margin: 0 auto 16px; border-radius: 12px;
    border: 1px solid var(--bh); display: grid; place-items: center; background: var(--s2);
  }
  .drop-icon svg { width: 22px; height: 22px; stroke: var(--t2) }
  .drop-zone b { display: block; font-size: 15px; font-weight: 600; margin-bottom: 4px }
  .drop-zone small { font-size: 13px; color: var(--t3) }
  .file-name { margin-top: 12px; font-size: 13px; font-weight: 600; color: #fca5a5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  input[type=file] { display: none }
  .fields-bar { padding: 10px 16px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 16px; flex-wrap: wrap }
  .fields-label { font-size: 11px; color: var(--t3); font-weight: 700; text-transform: uppercase; letter-spacing: .06em; flex-shrink: 0 }
  .field-toggle { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--t2); cursor: pointer; user-select: none }
  .field-toggle input[type=checkbox] { accent-color: var(--accent); width: 13px; height: 13px; cursor: pointer }
  .field-toggle:has(input:checked) { color: var(--t1) }
  .card-actions { padding: 12px 16px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
  .spacer { flex: 1 }
  /* buttons */
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--r); border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s; text-decoration: none }
  .btn:disabled { opacity: .35; cursor: not-allowed }
  .btn-primary { background: var(--accent); color: #fff }
  .btn-primary:hover:not(:disabled) { opacity: .88; transform: translateY(-1px) }
  .btn-outline { background: transparent; color: var(--t2); border: 1px solid var(--border) }
  .btn-outline:hover:not(:disabled) { background: var(--s2); color: var(--t1); border-color: var(--bh); transform: translateY(-1px) }
  .btn-ghost { background: transparent; color: var(--t3); border: 1px solid transparent; font-size: 13px; font-weight: 500 }
  .btn-ghost:hover { color: var(--t1) }
  /* status */
  .status { width: 100%; max-width: 560px; display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: 13px; color: var(--t3); padding: 0 4px }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3); flex-shrink: 0 }
  .dot.ok { background: var(--green) }
  .dot.error { background: var(--red) }
  .dot.busy { background: var(--amber); animation: blink .9s infinite }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }
  .status.ok { color: var(--green) }
  .status.error { color: var(--red) }
  /* results */
  .results { width: 100%; max-width: 860px }
  .results-top { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap }
  .results-top h2 { font-size: 14px; font-weight: 700 }
  .count { padding: 2px 9px; border-radius: 999px; background: rgba(220,38,38,.1); color: #fca5a5; font-size: 12px; font-weight: 700; border: 1px solid rgba(220,38,38,.2) }
  .dl-row { margin-left: auto; display: flex; gap: 6px }
  .tbl-wrap { border: 1px solid var(--border); border-radius: 12px; overflow: hidden }
  .tbl-inner { overflow: auto; max-height: 65vh }
  table { width: 100%; border-collapse: collapse; font-size: 13px }
  thead th { padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--t3); background: var(--s1); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 1 }
  tbody td { padding: 11px 14px; border-bottom: 1px solid var(--border); color: var(--t2); vertical-align: middle }
  tbody tr:last-child td { border-bottom: none }
  tbody tr:hover td { background: rgba(255,255,255,.02) }
  td:first-child { width: 52px; color: var(--t3); font-variant-numeric: tabular-nums }
  td:nth-child(2) { color: var(--t1) }
  td:nth-child(3) { font-family: ui-monospace, monospace }
  .chip { display: inline-block; padding: 3px 9px; border-radius: 6px; font-size: 12px; font-weight: 600; background: rgba(34,197,94,.1); color: #86efac; border: 1px solid rgba(34,197,94,.12) }
  .chip.empty { background: rgba(113,113,122,.1); color: var(--t3); border-color: transparent; font-style: italic }
  /* auth forms */
  .form-page { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px 20px }
  .form-card { width: 100%; max-width: 380px; background: var(--s1); border: 1px solid var(--border); border-radius: 16px; border-top: 2px solid var(--accent); padding: 32px }
  .form-card h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px }
  .form-card .sub { color: var(--t2); font-size: 14px; margin-bottom: 24px }
  .form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px }
  .form-group label { font-size: 12px; font-weight: 600; color: var(--t2); text-transform: uppercase; letter-spacing: .05em }
  .form-input { background: var(--s2); border: 1px solid var(--border); border-radius: var(--r); padding: 9px 12px; color: var(--t1); font-size: 14px; width: 100%; transition: border-color .15s }
  .form-input:focus { outline: none; border-color: var(--accent) }
  .form-error { background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.25); color: #fca5a5; padding: 10px 14px; border-radius: var(--r); font-size: 13px; margin-bottom: 16px }
  .form-ok { background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.25); color: #86efac; padding: 10px 14px; border-radius: var(--r); font-size: 13px; margin-bottom: 16px }
  .form-foot { text-align: center; font-size: 13px; color: var(--t3); margin-top: 20px }
  .form-foot a { color: var(--t2); text-decoration: none }
  .form-foot a:hover { color: var(--t1) }
  /* plans grid */
  .plans-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; width: 100%; max-width: 860px }
  .plan-card { background: var(--s1); border: 1px solid var(--border); border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 12px; transition: border-color .15s }
  .plan-card:hover { border-color: var(--bh) }
  .plan-card.featured { border-color: var(--accent); border-top: 2px solid var(--accent) }
  .plan-name { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--t2) }
  .plan-price { font-size: 2rem; font-weight: 800; letter-spacing: -.04em }
  .plan-price span { font-size: 14px; font-weight: 500; color: var(--t2) }
  .plan-desc { font-size: 13px; color: var(--t2); flex: 1 }
  /* dashboard */
  .dash-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; width: 100%; max-width: 860px }
  .stat-card { background: var(--s1); border: 1px solid var(--border); border-radius: 12px; padding: 20px }
  .stat-card .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--t3); margin-bottom: 8px }
  .stat-card .stat-value { font-size: 1.5rem; font-weight: 700 }
  .stat-card .stat-sub { font-size: 12px; color: var(--t3); margin-top: 4px }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700 }
  .badge-ok { background: rgba(34,197,94,.1); color: #86efac; border: 1px solid rgba(34,197,94,.15) }
  .badge-warn { background: rgba(245,158,11,.1); color: #fbbf24; border: 1px solid rgba(245,158,11,.15) }
  .badge-neutral { background: rgba(113,113,122,.1); color: var(--t3); border: 1px solid var(--border) }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--t3); margin-bottom: 12px }
  /* alert */
  .alert { padding: 14px 20px; border-radius: 12px; font-size: 14px; width: 100%; max-width: 560px; text-align: center }
  .alert-warn { background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.2); color: #fbbf24 }
  .alert-ok { background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.2); color: #86efac }
  /* footer */
  footer { border-top: 1px solid var(--border); padding: 20px 24px; text-align: center; font-size: 12px; color: var(--t3) }
  footer a { color: var(--t3) }
  footer a:hover { color: var(--t2) }
  @media (max-width: 600px) { .page { padding: 32px 12px 60px } .card,.status,.results { max-width: 100% } }
`;

// ── HTML helpers ───────────────────────────────────────────────────────────────
function topbar(user, sub, csrfToken = "") {
  const right = user
    ? `<a class="topbar-link" href="/planos">Planos</a>
       <a class="topbar-link" href="/conta/acesso">Acesso</a>
       <a class="topbar-link" href="/dashboard">${esc(user.name || user.email)}</a>
       <form method="POST" action="/auth/logout" style="display:inline">
         ${hiddenCsrfInput(csrfToken)}
         <button class="topbar-link" type="submit">Sair</button>
       </form>`
    : `<a class="topbar-link" href="/planos">Planos</a>
       <a class="topbar-link" href="/login">Entrar</a>
       <a class="topbar-cta" href="/register">Criar conta</a>`;
  return `<div class="topbar">
    <a class="logo" href="/"><div class="logo-mark">EG</div>Extrator GAN</a>
    <div class="topbar-sep"></div>
    ${right}
  </div>`;
}

function shell(title, body, user, sub, csrfToken = "") {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf-token" content="${esc(csrfToken)}">
<title>${esc(title)} — Extrator GAN</title>
<style>${CSS}</style></head><body>
${topbar(user, sub, csrfToken)}
${body}
<footer>Extrator GAN &middot; Elias Samuel &middot; <a href="https://github.com/Eli2s">github.com/Eli2s</a></footer>
</body></html>`;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Page: Landing (visitante) ──────────────────────────────────────────────────
function landingHtml(user, sub) {
  return shell("Extrator de Endereços", `
  <div class="page">
    <div class="hero">
      <div class="pill">&#x2736; Extrator de endereços</div>
      <h1>Transforme PDFs em<br><span class="gr">dados prontos</span></h1>
      <p>Faça upload da lista GAN e exporte os endereços em Excel ou TXT em segundos.</p>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">
      <a class="btn btn-primary" href="/planos">Ver planos</a>
      <a class="btn btn-outline" href="/checkout-convidado/avulso_1">Comprar sem login</a>
    </div>
    <div class="plans-grid" style="margin-top:8px">
      <div class="plan-card">
        <div class="plan-name">Avulso</div>
        <div class="plan-price">R$2<span>,90</span></div>
        <div class="plan-desc">1 extração, sem validade.</div>
        <a class="btn btn-outline" href="/planos">Comprar</a>
      </div>
      <div class="plan-card featured">
        <div class="plan-name">Semanal</div>
        <div class="plan-price">R$9<span>,90</span></div>
        <div class="plan-desc">Ilimitado por 7 dias.</div>
        <a class="btn btn-primary" href="/planos">Comprar</a>
      </div>
      <div class="plan-card">
        <div class="plan-name">Mensal</div>
        <div class="plan-price">R$29<span>,90</span></div>
        <div class="plan-desc">Ilimitado por 30 dias.</div>
        <a class="btn btn-outline" href="/planos">Comprar</a>
      </div>
    </div>
  </div>`, user, sub);
}

// ── Page: Tool ─────────────────────────────────────────────────────────────────
function toolHtml(user, sub, csrfToken) {
  const credInfo = sub
    ? sub.credits_remaining !== null
      ? `<span class="badge badge-ok">${sub.credits_remaining} crédito${sub.credits_remaining !== 1 ? "s" : ""}</span>`
      : `<span class="badge badge-ok">Ilimitado até ${sub.expires_at ? formatDateOnly(sub.expires_at) : "—"}</span>`
    : "";

  return shell("Extrair Endereços", `
  <div class="page">
    <div class="hero">
      <div class="pill">&#x2736; Extrator de endereços</div>
      <h1>Transforme PDFs em<br><span class="gr">dados prontos</span></h1>
      <p>Faça upload da lista GAN e exporte os endereços em Excel ou TXT em segundos. ${credInfo}</p>
    </div>
    <div class="card">
      <label class="drop-zone" id="drop">
        <div class="drop-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <b>Arraste o PDF aqui ou clique para escolher</b>
        <small>Listas GAN &middot; máximo 50 MB</small>
        <div class="file-name" id="fileName"></div>
        <input id="pdf" type="file" accept=".pdf">
      </label>
      <div class="fields-bar">
        <span class="fields-label">Campos:</span>
        <label class="field-toggle"><input type="checkbox" id="fEndereco" checked><span>Endereço</span></label>
        <label class="field-toggle"><input type="checkbox" id="fNumero"><span>Nº separado</span></label>
        <label class="field-toggle"><input type="checkbox" id="fBairro" checked><span>Bairro</span></label>
        <label class="field-toggle"><input type="checkbox" id="fCep" checked><span>CEP</span></label>
      </div>
      <div class="card-actions">
        <button id="extractBtn" class="btn btn-primary" disabled>Extrair endereços</button>
        <div class="spacer"></div>
        <button id="dlXlsx" class="btn btn-outline" disabled>&#x2193; Excel</button>
        <button id="dlTxt" class="btn btn-outline" disabled>&#x2193; TXT</button>
      </div>
    </div>
    <div class="status" id="status"><div class="dot" id="dot"></div><span id="statusText">Aguardando arquivo</span></div>
    <div class="results" id="results" hidden>
      <div class="results-top">
        <h2>Endereços extraídos</h2>
        <span class="count" id="count">0</span>
        <div class="dl-row">
          <button id="dlXlsx2" class="btn btn-outline">&#x2193; Excel</button>
          <button id="dlTxt2" class="btn btn-outline">&#x2193; TXT</button>
        </div>
      </div>
      <div class="tbl-wrap"><div class="tbl-inner">
        <table>
          <thead><tr><th>#</th><th>Endereço</th><th>CEP</th><th>Bairro</th></tr></thead>
          <tbody id="tbody"></tbody>
        </table>
      </div></div>
    </div>
  </div>
<script>
  let file = null, result = null, baseName = "enderecos";
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";

  function splitAddr(full) {
    const m = full.match(/^(.+?),?\\s+(\\d[\\w\\s\\-.\/]*)$/);
    return m ? { logradouro: m[1].trim(), numero: m[2].trim() } : { logradouro: full, numero: "" };
  }
  function buildCols() {
    const fEnd = document.getElementById("fEndereco").checked;
    const fNum = document.getElementById("fNumero").checked;
    const fBai = document.getElementById("fBairro").checked;
    const fCep = document.getElementById("fCep").checked;
    const cols = [];
    if (fEnd && !fNum) cols.push({ label: "ENDEREÇO",   get: r => r.endereco });
    if (fEnd &&  fNum) cols.push({ label: "LOGRADOURO", get: r => splitAddr(r.endereco).logradouro });
    if (fNum)          cols.push({ label: "NÚMERO",     get: r => splitAddr(r.endereco).numero });
    if (fBai)          cols.push({ label: "BAIRRO",     get: r => r.bairro });
    if (fCep)          cols.push({ label: "CEP",        get: r => r.cep });
    return cols;
  }
  const drop = document.getElementById("drop");
  const input = document.getElementById("pdf");
  const fileName = document.getElementById("fileName");
  const status = document.getElementById("status");
  const dot = document.getElementById("dot");
  const statusText = document.getElementById("statusText");
  const extractBtn = document.getElementById("extractBtn");
  const dlXlsx = document.getElementById("dlXlsx");
  const dlTxt = document.getElementById("dlTxt");
  const dlXlsx2 = document.getElementById("dlXlsx2");
  const dlTxt2 = document.getElementById("dlTxt2");
  const results = document.getElementById("results");
  const tbody = document.getElementById("tbody");
  const count = document.getElementById("count");

  function setStatus(msg, tone) {
    statusText.textContent = msg;
    dot.className = "dot" + (tone ? " " + tone : "");
    status.className = "status" + (tone ? " " + tone : "");
  }
  function setBusy(busy) {
    extractBtn.disabled = !file || busy;
    const noResult = !result || busy;
    dlXlsx.disabled = noResult; dlTxt.disabled = noResult;
    dlXlsx2.disabled = noResult; dlTxt2.disabled = noResult;
  }
  function setFile(f) {
    file = f;
    baseName = f.name.replace(/\\.pdf$/i, "") || "enderecos";
    fileName.textContent = f.name;
    result = null; results.hidden = true;
    tbody.replaceChildren(); count.textContent = "0";
    setStatus("Arquivo selecionado — clique em Extrair", "");
    setBusy(false);
  }
  function renderRows(items) {
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const tr = document.createElement("tr");
      [String(i + 1), item.endereco || "", item.cep || "", item.bairro || ""].forEach((val, ci) => {
        const td = document.createElement("td");
        if (ci === 3) {
          const span = document.createElement("span");
          span.className = "chip" + (!val ? " empty" : "");
          span.textContent = val || "—";
          td.appendChild(span);
        } else { td.textContent = val; }
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });
    tbody.replaceChildren(frag);
  }
  input.addEventListener("change", () => { if (input.files[0]) setFile(input.files[0]); });
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => {
    e.preventDefault(); drop.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith(".pdf")) setFile(f);
  });
  extractBtn.addEventListener("click", async () => {
    if (!file) return;
    setBusy(true); setStatus("Processando PDF…", "busy");
    const form = new FormData();
    form.append("pdf", file);
    try {
      const res = await fetch("/extrair", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: form });
      const data = await res.json();
      if (!data.ok) throw new Error(data.erro);
      result = data.enderecos;
      renderRows(result);
      count.textContent = String(result.length);
      results.hidden = false;
      setStatus("Extração concluída · " + result.length + " endereços", "ok");
    } catch (e) {
      setStatus("Erro: " + e.message, "error");
    } finally { setBusy(false); }
  });
  async function download(fmt) {
    if (!result) return;
    setBusy(true); setStatus("Gerando " + fmt.toUpperCase() + "…", "busy");
    try {
      const cols = buildCols();
      const colunas = cols.map(c => c.label);
      const linhas = result.map(r => cols.map(c => c.get(r)));
      const res = await fetch("/baixar/" + fmt, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ colunas, linhas, nome: baseName })
      });
      if (!res.ok) throw new Error("Falha ao gerar download.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = baseName + (fmt === "xlsx" ? ".xlsx" : ".txt");
      a.click(); URL.revokeObjectURL(url);
      setStatus("Download pronto.", "ok");
    } catch (e) {
      setStatus("Erro: " + e.message, "error");
    } finally { setBusy(false); }
  }
  dlXlsx.addEventListener("click", () => download("xlsx"));
  dlXlsx2.addEventListener("click", () => download("xlsx"));
  dlTxt.addEventListener("click", () => download("txt"));
  dlTxt2.addEventListener("click", () => download("txt"));
</script>`, user, sub, csrfToken);
}

// ── Page: Login ────────────────────────────────────────────────────────────────
function loginHtml(error, ok, csrfToken) {
  return shell("Entrar", `
  <div class="form-page">
    <div class="form-card">
      <h1>Entrar</h1>
      <p class="sub">Entre com e-mail e senha. Se preferir, você também pode comprar e usar sem login prévio.</p>
      ${error ? `<div class="form-error">${esc(error)}</div>` : ""}
      ${ok ? `<div class="form-ok">${esc(ok)}</div>` : ""}
      <form method="POST" action="/auth/login">
        ${hiddenCsrfInput(csrfToken)}
        <div class="form-group">
          <label for="email">E-mail</label>
          <input class="form-input" type="email" id="email" name="email" required autocomplete="email">
        </div>
        <div class="form-group">
          <label for="password">Senha</label>
          <input class="form-input" type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Entrar</button>
      </form>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
        <a class="btn btn-outline" href="/register" style="justify-content:center;flex:1">Criar conta</a>
        <a class="btn btn-outline" href="/planos" style="justify-content:center;flex:1">Comprar sem login</a>
      </div>
    </div>
  </div>`, null, null, csrfToken);
}

// ── Page: Register ─────────────────────────────────────────────────────────────
function registerHtml(error, csrfToken) {
  return shell("Criar Conta", `
  <div class="form-page">
    <div class="form-card">
      <h1>Criar conta</h1>
      <p class="sub">Crie sua conta e comece a extrair.</p>
      ${error ? `<div class="form-error">${esc(error)}</div>` : ""}
      <form method="POST" action="/auth/register">
        ${hiddenCsrfInput(csrfToken)}
        <div class="form-group">
          <label for="name">Nome</label>
          <input class="form-input" type="text" id="name" name="name" required autocomplete="name">
        </div>
        <div class="form-group">
          <label for="email">E-mail</label>
          <input class="form-input" type="email" id="email" name="email" required autocomplete="email">
        </div>
        <div class="form-group">
          <label for="password">Senha</label>
          <input class="form-input" type="password" id="password" name="password" required autocomplete="new-password" minlength="8">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Criar conta</button>
      </form>
      <p class="form-foot">Já tem conta? <a href="/login">Entrar</a></p>
    </div>
  </div>`, null, null, csrfToken);
}

function guestCheckoutHtml(plan, error, values, csrfToken) {
  return shell("Comprar sem login", `
  <div class="form-page">
    <div class="form-card" style="max-width:460px">
      <h1>Comprar sem login</h1>
      <p class="sub">Informe nome e e-mail. O acesso fica liberado na mesma sessão após o pagamento.</p>
      ${error ? `<div class="form-error">${esc(error)}</div>` : ""}
      <div style="background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:20px">
        <div style="font-size:12px;color:var(--t3);margin-bottom:4px">Plano</div>
        <div style="font-weight:700">${esc(plan.name)}</div>
        <div style="font-size:13px;color:var(--t2);margin-top:4px">R$ ${Number(plan.price_brl).toFixed(2).replace(".", ",")}</div>
      </div>
      <form method="POST" action="/checkout-convidado/${esc(plan.id)}">
        ${hiddenCsrfInput(csrfToken)}
        <div class="form-group">
          <label for="name">Nome</label>
          <input class="form-input" type="text" id="name" name="name" required autocomplete="name" value="${esc(values?.name || "")}">
        </div>
        <div class="form-group">
          <label for="email">E-mail</label>
          <input class="form-input" type="email" id="email" name="email" required autocomplete="email" value="${esc(values?.email || "")}">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Continuar para pagamento</button>
      </form>
      <p class="form-foot">Já tem conta? <a href="/login">Entrar</a></p>
    </div>
  </div>`, null, null, csrfToken);
}

function accountAccessHtml(user, error, ok, csrfToken) {
  return shell("Definir acesso", `
  <div class="form-page">
    <div class="form-card">
      <h1>Definir senha</h1>
      <p class="sub">Crie uma senha para entrar depois com o e-mail <strong>${esc(user.email)}</strong>.</p>
      ${error ? `<div class="form-error">${esc(error)}</div>` : ""}
      ${ok ? `<div class="form-ok">${esc(ok)}</div>` : ""}
      <form method="POST" action="/conta/acesso">
        ${hiddenCsrfInput(csrfToken)}
        <div class="form-group">
          <label for="password">Nova senha</label>
          <input class="form-input" type="password" id="password" name="password" required autocomplete="new-password" minlength="8">
        </div>
        <div class="form-group">
          <label for="confirmPassword">Confirmar senha</label>
          <input class="form-input" type="password" id="confirmPassword" name="confirmPassword" required autocomplete="new-password" minlength="8">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Salvar senha</button>
      </form>
    </div>
  </div>`, user, null, csrfToken);
}

// ── Page: Planos ───────────────────────────────────────────────────────────────
function planosHtml(user, sub, plans, csrfToken) {
  const cards = plans.map(p => {
    const featured = p.id === "semanal";
    const price = p.price_brl.toFixed(2).replace(".", ",");
    const descMap = {
      avulso_1: "1 extração de PDF, sem validade.",
      avulso_5: "5 extrações de PDF, sem validade.",
      semanal: "Extrações ilimitadas por 7 dias.",
      mensal: "Extrações ilimitadas por 30 dias.",
    };
    return `<div class="plan-card${featured ? " featured" : ""}">
      <div class="plan-name">${esc(p.name)}</div>
      <div class="plan-price">R$${price.split(",")[0]}<span>,${price.split(",")[1]}</span></div>
      <div class="plan-desc">${esc(descMap[p.id] || "")}</div>
      ${user
        ? `<form method="POST" action="/pagamento/criar/${esc(p.id)}">
             ${hiddenCsrfInput(csrfToken)}
             <button type="submit" class="btn ${featured ? "btn-primary" : "btn-outline"}" style="width:100%;justify-content:center">Comprar</button>
           </form>`
        : `<a class="btn ${featured ? "btn-primary" : "btn-outline"}" href="/checkout-convidado/${esc(p.id)}" style="justify-content:center;display:flex">Comprar sem login</a>`
      }
    </div>`;
  }).join("\n");

  return shell("Planos", `
  <div class="page">
    <div class="hero">
      <h1>Escolha seu <span class="gr">plano</span></h1>
      <p>Pague apenas o que usar. Sem assinaturas obrigatórias.</p>
    </div>
    <div class="plans-grid">${cards}</div>
  </div>`, user, sub, csrfToken);
}

// ── Page: Dashboard ────────────────────────────────────────────────────────────
function dashboardHtml(user, sub, logs, csrfToken) {
  const planInfo = sub
    ? `<span class="badge badge-ok">${esc(sub.plan_name)}</span>`
    : `<span class="badge badge-warn">Sem plano ativo</span>`;

  const creditos = sub
    ? sub.credits_remaining !== null
      ? `${sub.credits_remaining} crédito${sub.credits_remaining !== 1 ? "s" : ""}`
      : "Ilimitado"
    : "—";

  const validade = sub
    ? sub.expires_at
      ? formatDateOnly(sub.expires_at)
      : "Sem validade"
    : "—";

  const logRows = logs.length
    ? logs.map((l, i) => `<tr>
        <td>${String(i + 1)}</td>
        <td>${esc(l.filename || "—")}</td>
        <td>${String(l.extracted_count)}</td>
        <td>${esc(l.plan_name || "—")}</td>
        <td>${formatDateTime(l.used_at)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="text-align:center;color:var(--t3);padding:28px">Nenhuma extração ainda.</td></tr>`;

  return shell("Dashboard", `
  <div class="page">
    <div style="width:100%;max-width:860px">
      <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">Olá, ${esc(user.name || user.email)}</h2>
      <p style="color:var(--t2);font-size:14px">Gerencie seu plano e veja o histórico de extrações.</p>
    </div>
    <div class="dash-grid">
      <div class="stat-card">
        <div class="stat-label">Plano ativo</div>
        <div class="stat-value">${planInfo}</div>
        <div class="stat-sub">Validade: ${esc(validade)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Créditos</div>
        <div class="stat-value">${esc(creditos)}</div>
        ${!sub ? `<div class="stat-sub"><a href="/planos" style="color:var(--accent)">Comprar plano →</a></div>` : ""}
      </div>
      <div class="stat-card">
        <div class="stat-label">Total extraído</div>
        <div class="stat-value">${logs.reduce((s, l) => s + l.extracted_count, 0)}</div>
        <div class="stat-sub">endereços no total</div>
      </div>
    </div>
    <div style="width:100%;max-width:860px">
      <div class="section-title">Histórico de extrações</div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>#</th><th>Arquivo</th><th>Endereços</th><th>Plano</th><th>Data</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table>
      </div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <a class="btn btn-primary" href="/">Extrair agora</a>
      <a class="btn btn-outline" href="/planos">Ver planos</a>
    </div>
  </div>`, user, sub, csrfToken);
}

// ── Page: Simulação pagamento ──────────────────────────────────────────────────
function simHtml(user, plan, txId, csrfToken) {
  return shell("Confirmar Pagamento", `
  <div class="page">
    <div class="form-card" style="max-width:420px">
      <h1>Pagamento simulado</h1>
      <p class="sub" style="margin-bottom:20px">Ambiente de testes — nenhuma cobrança real.</p>
      <div style="background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:20px">
        <div style="font-size:12px;color:var(--t3);margin-bottom:4px">Plano</div>
        <div style="font-weight:700">${esc(plan.name)}</div>
        <div style="font-size:13px;color:var(--t2);margin-top:4px">R$ ${plan.price_brl.toFixed(2).replace(".", ",")}</div>
      </div>
      <form method="POST" action="/pagamento/simulacao/${esc(plan.id)}">
        ${hiddenCsrfInput(csrfToken)}
        <input type="hidden" name="txId" value="${esc(String(txId))}">
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">✓ Aprovar pagamento (teste)</button>
      </form>
      <p class="form-foot" style="margin-top:12px"><a href="/planos">Cancelar</a></p>
    </div>
  </div>`, user, null, csrfToken);
}

function checkoutHtml(user, plan, txId, csrfToken) {
  const amount = Number(plan.price_brl).toFixed(2);
  const userEmail = esc(user.email || "");
  const userName = esc(user.name || "");
  const publicKey = esc(MP_PUBLIC_KEY);

  return shell("Finalizar pagamento", `
  <div class="page">
    <div class="hero" style="max-width:760px">
      <div class="pill">&#x2736; Checkout Transparente</div>
      <h1>Pague seu <span class="gr">${esc(plan.name)}</span></h1>
      <p>Escolha Pix ou cartão e finalize sem sair do site.</p>
    </div>

    <div class="card" style="max-width:760px">
      <div class="card-pad">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:20px">
          <div>
            <div class="section-title" style="margin-bottom:6px">Plano</div>
            <div style="font-size:20px;font-weight:700">${esc(plan.name)}</div>
          </div>
          <div style="text-align:right">
            <div class="section-title" style="margin-bottom:6px">Valor</div>
            <div style="font-size:20px;font-weight:800">R$ ${amount.replace(".", ",")}</div>
          </div>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
          <button class="btn btn-primary" id="tabPix" type="button">Pix</button>
          <button class="btn btn-outline" id="tabCard" type="button">Cartão</button>
        </div>

        <div id="statusBox" class="status" style="max-width:none;padding:0 0 12px">
          <div class="dot" id="payDot"></div>
          <span id="payStatus">Preencha os dados para pagar.</span>
        </div>

        <section id="pixPanel">
          <div class="form-group">
            <label for="pixCpf">CPF do pagador</label>
            <input class="form-input" id="pixCpf" inputmode="numeric" autocomplete="off" placeholder="Somente números">
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" id="pixBtn" type="button">Gerar Pix</button>
            <button class="btn btn-outline" id="pixCheckBtn" type="button" disabled>Verificar pagamento</button>
          </div>
          <div id="pixResult" hidden style="margin-top:18px;border-top:1px solid var(--border);padding-top:18px">
            <div id="pixQrWrap" style="display:flex;justify-content:center;margin-bottom:16px"></div>
            <div class="form-group">
              <label for="pixCode">Copia e cola</label>
              <textarea class="form-input" id="pixCode" rows="4" readonly></textarea>
            </div>
            <a id="pixTicketLink" class="btn btn-outline" href="#" target="_blank" rel="noreferrer">Abrir comprovante</a>
          </div>
        </section>

        <section id="cardPanel" hidden>
          <div id="cardUnavailable" class="alert alert-warn" ${publicKey ? "hidden" : ""}>
            MP_PUBLIC_KEY não configurada.
          </div>
          <form id="form-checkout" ${publicKey ? "" : "hidden"}>
            <div class="form-group">
              <label>Número do cartão</label>
              <div id="form-checkout__cardNumber" class="form-input" style="padding:11px 12px;height:auto"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div class="form-group">
                <label>Validade</label>
                <div id="form-checkout__expirationDate" class="form-input" style="padding:11px 12px;height:auto"></div>
              </div>
              <div class="form-group">
                <label>CVV</label>
                <div id="form-checkout__securityCode" class="form-input" style="padding:11px 12px;height:auto"></div>
              </div>
            </div>
            <div class="form-group">
              <label for="form-checkout__cardholderName">Nome do titular</label>
              <input class="form-input" type="text" id="form-checkout__cardholderName" value="${userName}">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div class="form-group">
                <label for="form-checkout__issuer">Banco emissor</label>
                <select class="form-input" id="form-checkout__issuer"></select>
              </div>
              <div class="form-group">
                <label for="form-checkout__installments">Parcelas</label>
                <select class="form-input" id="form-checkout__installments"></select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div class="form-group">
                <label for="form-checkout__identificationType">Documento</label>
                <select class="form-input" id="form-checkout__identificationType"></select>
              </div>
              <div class="form-group">
                <label for="form-checkout__identificationNumber">Número</label>
                <input class="form-input" type="text" id="form-checkout__identificationNumber" inputmode="numeric">
              </div>
            </div>
            <div class="form-group">
              <label for="form-checkout__cardholderEmail">E-mail</label>
              <input class="form-input" type="email" id="form-checkout__cardholderEmail" value="${userEmail}">
            </div>
            <button class="btn btn-primary" type="submit" id="form-checkout__submit">Pagar com cartão</button>
            <progress value="0" class="progress-bar" style="width:100%;margin-top:12px"></progress>
          </form>
        </section>
      </div>
    </div>
  </div>
  <script src="https://sdk.mercadopago.com/js/v2"></script>
  <script>
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
    const txId = ${Number(txId)};
    const planId = ${JSON.stringify(plan.id)};
    const amount = ${JSON.stringify(amount)};
    const mpPublicKey = ${JSON.stringify(MP_PUBLIC_KEY)};
    const pixPanel = document.getElementById("pixPanel");
    const cardPanel = document.getElementById("cardPanel");
    const tabPix = document.getElementById("tabPix");
    const tabCard = document.getElementById("tabCard");
    const payDot = document.getElementById("payDot");
    const payStatus = document.getElementById("payStatus");
    const pixBtn = document.getElementById("pixBtn");
    const pixCheckBtn = document.getElementById("pixCheckBtn");
    const pixResult = document.getElementById("pixResult");
    const pixQrWrap = document.getElementById("pixQrWrap");
    const pixCode = document.getElementById("pixCode");
    const pixTicketLink = document.getElementById("pixTicketLink");
    let pixPaymentId = null;

    function setStatus(message, tone = "") {
      payStatus.textContent = message;
      payDot.className = "dot" + (tone ? " " + tone : "");
    }

    function toggleTab(mode) {
      const isPix = mode === "pix";
      pixPanel.hidden = !isPix;
      cardPanel.hidden = isPix;
      tabPix.className = "btn " + (isPix ? "btn-primary" : "btn-outline");
      tabCard.className = "btn " + (!isPix ? "btn-primary" : "btn-outline");
    }

    async function parseJsonResponse(res) {
      const data = await res.json().catch(() => ({ ok: false, erro: "Resposta inválida do servidor." }));
      if (!res.ok || data.ok === false) throw new Error(data.erro || "Falha no pagamento.");
      return data;
    }

    tabPix.addEventListener("click", () => toggleTab("pix"));
    tabCard.addEventListener("click", () => toggleTab("card"));

    pixBtn.addEventListener("click", async () => {
      const identificationNumber = document.getElementById("pixCpf").value.replace(/\\D/g, "");
      if (identificationNumber.length !== 11) {
        setStatus("Informe um CPF válido para gerar o Pix.", "error");
        return;
      }
      pixBtn.disabled = true;
      setStatus("Gerando cobrança Pix...", "busy");
      try {
        const res = await fetch("/pagamento/transparente/pix/" + planId, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ txId, identificationNumber })
        });
        const data = await parseJsonResponse(res);
        pixPaymentId = data.paymentId;
        pixCheckBtn.disabled = false;
        pixResult.hidden = false;
        pixQrWrap.innerHTML = data.qrCodeBase64 ? '<img alt="QR Code Pix" style="max-width:260px;width:100%;background:#fff;padding:12px;border-radius:12px" src="data:image/png;base64,' + data.qrCodeBase64 + '">' : "";
        pixCode.value = data.qrCode || "";
        pixTicketLink.href = data.ticketUrl || "#";
        setStatus("Pix gerado. Faça o pagamento e depois clique em verificar.", "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        pixBtn.disabled = false;
      }
    });

    pixCheckBtn.addEventListener("click", async () => {
      if (!pixPaymentId) return;
      pixCheckBtn.disabled = true;
      setStatus("Verificando pagamento Pix...", "busy");
      try {
        const res = await fetch("/pagamento/transparente/status/" + txId + "?paymentId=" + encodeURIComponent(pixPaymentId), {
          headers: { "X-CSRF-Token": csrfToken }
        });
        const data = await parseJsonResponse(res);
        if (data.approved) {
          window.location.href = "/pagamento/sucesso";
          return;
        }
        setStatus("Status atual: " + data.status + ". Aguarde a compensação.", "busy");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        pixCheckBtn.disabled = false;
      }
    });

    if (mpPublicKey) {
      const mp = new MercadoPago(mpPublicKey);
      const cardForm = mp.cardForm({
        amount,
        iframe: true,
        form: {
          id: "form-checkout",
          cardNumber: { id: "form-checkout__cardNumber", placeholder: "Número do cartão" },
          expirationDate: { id: "form-checkout__expirationDate", placeholder: "MM/AA" },
          securityCode: { id: "form-checkout__securityCode", placeholder: "CVV" },
          cardholderName: { id: "form-checkout__cardholderName", placeholder: "Titular do cartão" },
          issuer: { id: "form-checkout__issuer", placeholder: "Banco emissor" },
          installments: { id: "form-checkout__installments", placeholder: "Parcelas" },
          identificationType: { id: "form-checkout__identificationType", placeholder: "Documento" },
          identificationNumber: { id: "form-checkout__identificationNumber", placeholder: "Número do documento" },
          cardholderEmail: { id: "form-checkout__cardholderEmail", placeholder: "E-mail" }
        },
        callbacks: {
          onSubmit: async (event) => {
            event.preventDefault();
            setStatus("Processando pagamento com cartão...", "busy");
            const submitButton = document.getElementById("form-checkout__submit");
            submitButton.disabled = true;
            try {
              const payload = cardForm.getCardFormData();
              const res = await fetch("/pagamento/transparente/cartao/" + planId, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
                body: JSON.stringify({
                  txId,
                  token: payload.token,
                  issuer_id: payload.issuerId ? Number(payload.issuerId) : undefined,
                  payment_method_id: payload.paymentMethodId,
                  installments: Number(payload.installments),
                  payer: {
                    email: payload.cardholderEmail,
                    identificationType: payload.identificationType,
                    identificationNumber: payload.identificationNumber,
                    name: document.getElementById("form-checkout__cardholderName").value
                  }
                })
              });
              const data = await parseJsonResponse(res);
              if (data.approved) {
                window.location.href = "/pagamento/sucesso";
                return;
              }
              setStatus("Pagamento criado com status " + data.status + ".", data.status === "pending" ? "busy" : "error");
            } catch (error) {
              setStatus(error.message, "error");
            } finally {
              submitButton.disabled = false;
            }
          },
          onFetching: () => {
            const progressBar = document.querySelector(".progress-bar");
            progressBar.removeAttribute("value");
            return () => progressBar.setAttribute("value", "0");
          }
        }
      });
    }
  </script>`, user, null, csrfToken);
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function sanitizeDownloadName(name) {
  return String(name || "enderecos")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "enderecos";
}

function hiddenCsrfInput(csrfToken) {
  return csrfToken ? `<input type="hidden" name="_csrf" value="${esc(csrfToken)}">` : "";
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

function safeTokenEquals(expected, provided) {
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");
  const providedBuffer = Buffer.from(String(provided || ""), "utf8");
  if (expectedBuffer.length === 0 || expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireCsrf(req, res, next) {
  const provided = req.get("x-csrf-token") || req.body?._csrf;
  if (safeTokenEquals(req.session?.csrfToken, provided)) {
    return next();
  }

  if (isApiRequest(req)) {
    return res.status(403).json({ ok: false, erro: "Falha de validacao CSRF." });
  }

  return res.status(403).type("html").send(shell("Sessao invalida", `
    <div class="form-page">
      <div class="form-card">
        <h1>Sessao invalida</h1>
        <p class="sub">Atualize a pagina e tente novamente.</p>
      </div>
    </div>`, req.user || null, null, req.session?.csrfToken || ""));
}

function requireApiAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ ok: false, erro: "Login necessario. Acesse /login." });
}

function isApiRequest(req) {
  return req.path.startsWith("/extrair")
    || req.path.startsWith("/baixar/")
    || req.path === "/me"
    || req.is("multipart/form-data")
    || req.is("application/json");
}

function normalizeTextField(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function formatDateOnly(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16).replace("T", " ");
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function splitFullName(nameOrEmail) {
  const raw = String(nameOrEmail || "").trim();
  if (!raw) return { firstName: "Cliente", lastName: "Extrator" };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: "Extrator" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function buildNotificationUrl() {
  return BASE_URL.startsWith("https://") ? `${BASE_URL}/pagamento/webhook` : undefined;
}

function buildPayerFromUser(user, overrides = {}) {
  const email = normalizeTextField(overrides.email || user?.email, 254).toLowerCase();
  const docType = normalizeTextField(overrides.identificationType || "CPF", 20).toUpperCase();
  const docNumber = String(overrides.identificationNumber || "").replace(/\D/g, "").slice(0, 20);
  const names = splitFullName(overrides.name || user?.name || user?.email);
  return {
    email,
    first_name: names.firstName,
    last_name: names.lastName,
    identification: docNumber ? { type: docType, number: docNumber } : undefined,
  };
}

function isRecurringPlan(plan) {
  return Number(plan?.duration_days || 0) > 0;
}

function getRecurringFrequency(plan) {
  if (String(plan?.id) === "semanal") {
    return { frequency: 1, frequencyType: "weeks" };
  }
  return { frequency: 1, frequencyType: "months" };
}

async function mercadoPagoRequest(pathname, { method = "GET", body } = {}) {
  if (!MP_TOKEN) {
    throw new Error("Mercado Pago nao configurado.");
  }

  const res = await fetch(`https://api.mercadopago.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`Mercado Pago API ${method} ${pathname} falhou: ${res.status} ${errorBody}`.slice(0, 500));
  }

  return res.json();
}

async function createRecurringCheckout(plan, user, txId) {
  const { frequency, frequencyType } = getRecurringFrequency(plan);
  const reason = `Extrator GAN - ${plan.name}`;
  const startDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const response = await mercadoPagoRequest("/preapproval", {
    method: "POST",
    body: {
      reason,
      payer_email: user.email,
      external_reference: String(txId),
      back_url: `${BASE_URL}/pagamento/sucesso?txId=${txId}&recorrente=1`,
      status: "pending",
      auto_recurring: {
        frequency,
        frequency_type: frequencyType,
        transaction_amount: Number(plan.price_brl),
        currency_id: "BRL",
        start_date: startDate,
      },
    },
  });

  if (!response?.init_point) {
    throw new Error("Mercado Pago nao retornou link de assinatura.");
  }

  await updateTransactionStatus(txId, response.status || "pending", String(response.id || ""));
  return response;
}

async function syncRecurringSubscriptionStatus(txId, preapprovalId = null) {
  const tx = await getTransactionById(txId);
  if (!tx) return { approved: false, status: "not_found" };

  const effectiveId = String(preapprovalId || tx.mp_payment_id || "");
  if (!effectiveId) return { approved: false, status: "pending" };

  const subscription = await mercadoPagoRequest(`/preapproval/${encodeURIComponent(effectiveId)}`);
  const status = String(subscription?.status || "pending");
  const nextPeriodEnd = subscription?.next_payment_date
    || subscription?.auto_recurring?.end_date
    || null;

  if (status === "authorized") {
    await authorizeRecurringTransaction(txId, { mpPaymentId: effectiveId, expiresAt: nextPeriodEnd });
    return { approved: true, status, subscription };
  }

  await updateTransactionStatus(txId, status, effectiveId);
  return { approved: false, status, subscription };
}

async function syncPaymentStatus(txId, payment) {
  const paymentId = String(payment?.id || "");
  const status = String(payment?.status || "pending");
  if (!paymentId) return { approved: false, status };

  if (status === "approved") {
    await approveTransaction(txId, { mpPaymentId: paymentId });
    return { approved: true, status };
  }

  await updateTransactionStatus(txId, status, paymentId);
  return { approved: false, status };
}

async function establishUserSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      return req.session.save((saveErr) => saveErr ? reject(saveErr) : resolve());
    });
  });
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get("/healthz", asyncHandler(async (req, res) => {
  await getDb();
  res.json({ ok: true, runtime: "node", service: "extrator-enderecos-saas", database: "mysql" });
}));

app.get("/", asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user) return res.type("html").send(landingHtml(null, null));
  const sub = await getActiveSubscription(user.id);
  if (!sub) {
    return res.type("html").send(shell("Sem plano", `
      <div class="page">
        <div class="alert alert-warn">Você não tem um plano ativo. <a href="/planos" style="color:inherit;font-weight:700">Ver planos →</a></div>
        ${landingHtml(user, null).match(/<div class="plans-grid"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || ""}
      </div>`, user, null, req.csrfTokenValue));
  }
  return res.type("html").send(toolHtml(user, sub, req.csrfTokenValue));
}));

// Auth
app.get("/login", (req, res) => {
  if (req.user) return res.redirect("/");
  res.type("html").send(loginHtml(req.query.erro, req.query.ok, req.csrfTokenValue));
});

app.post("/auth/login", authLimiter, requireCsrf, async (req, res) => {
  try {
    const email = normalizeTextField(req.body?.email, 191).toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!email || !password) return res.type("html").send(loginHtml("Preencha todos os campos.", null, req.csrfTokenValue));
    const user = await loginUser(email, password);
    await establishUserSession(req, user.id);
    const sub = await getActiveSubscription(user.id);
    res.redirect(sub ? "/" : "/planos");
  } catch (err) {
    res.type("html").send(loginHtml(err.message, null, req.csrfTokenValue));
  }
});

app.get("/register", (req, res) => {
  if (req.user) return res.redirect("/");
  res.type("html").send(registerHtml(req.query.erro, req.csrfTokenValue));
});

app.post("/auth/register", authLimiter, requireCsrf, async (req, res) => {
  try {
    const name = normalizeTextField(req.body?.name, 191);
    const email = normalizeTextField(req.body?.email, 191).toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!name || !email || !password) return res.type("html").send(registerHtml("Preencha todos os campos.", req.csrfTokenValue));
    if (password.length < 8) return res.type("html").send(registerHtml("A senha deve ter ao menos 8 caracteres.", req.csrfTokenValue));
    const user = await createUser(email, password, name);
    await establishUserSession(req, user.id);
    res.redirect("/planos");
  } catch (err) {
    res.type("html").send(registerHtml(err.message, req.csrfTokenValue));
  }
});

app.get("/conta/acesso", requireAuth, (req, res) => {
  res.type("html").send(accountAccessHtml(req.user, null, req.query.ok, req.csrfTokenValue));
});

app.post("/conta/acesso", requireAuth, authLimiter, requireCsrf, async (req, res) => {
  try {
    const password = String(req.body?.password ?? "");
    const confirmPassword = String(req.body?.confirmPassword ?? "");
    if (!password || !confirmPassword) {
      return res.type("html").send(accountAccessHtml(req.user, "Preencha os dois campos.", null, req.csrfTokenValue));
    }
    if (password.length < 8) {
      return res.type("html").send(accountAccessHtml(req.user, "A senha deve ter ao menos 8 caracteres.", null, req.csrfTokenValue));
    }
    if (password !== confirmPassword) {
      return res.type("html").send(accountAccessHtml(req.user, "As senhas não conferem.", null, req.csrfTokenValue));
    }
    await updateUserPassword(req.user.id, password);
    if (req.session) {
      delete req.session.guestCheckout;
    }
    return res.redirect("/conta/acesso?ok=Senha+salva+com+sucesso");
  } catch (err) {
    return res.type("html").send(accountAccessHtml(req.user, err.message, null, req.csrfTokenValue));
  }
});

app.post("/auth/logout", requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("extrator.sid");
    res.redirect("/");
  });
});

app.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const sub = await getActiveSubscription(req.user.id);
  res.json({ ok: true, user: req.user, subscription: sub || null });
}));

// Plans
app.get("/planos", asyncHandler(async (req, res) => {
  const plans = await getPlans();
  const sub = req.user ? await getActiveSubscription(req.user.id) : null;
  res.type("html").send(planosHtml(req.user, sub, plans, req.csrfTokenValue));
}));

app.get("/checkout-convidado/:planId", asyncHandler(async (req, res) => {
  const plan = await getPlanById(req.params.planId);
  if (!plan) return res.redirect("/planos");
  if (req.user) return res.redirect("/planos");
  return res.type("html").send(guestCheckoutHtml(plan, req.query.erro, { name: "", email: "" }, req.csrfTokenValue));
}));

app.post("/checkout-convidado/:planId", authLimiter, paymentLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const plan = await getPlanById(req.params.planId);
  if (!plan) return res.redirect("/planos");
  if (req.user) return res.redirect(`/pagamento/criar/${plan.id}`);

  const name = normalizeTextField(req.body?.name, 191);
  const email = normalizeTextField(req.body?.email, 191).toLowerCase();
  if (!name || !email) {
    return res.type("html").send(guestCheckoutHtml(plan, "Preencha nome e e-mail.", { name, email }, req.csrfTokenValue));
  }

  const existingUser = await getUserByEmail(email);
  if (existingUser) {
    return res.type("html").send(guestCheckoutHtml(plan, "Este e-mail já possui conta. Faça login para continuar.", { name, email }, req.csrfTokenValue));
  }

  const generatedPassword = crypto.randomBytes(24).toString("hex");
  const user = await createUser(email, generatedPassword, name);
  await establishUserSession(req, user.id);
  req.session.guestCheckout = true;

  const txId = await createTransaction(user.id, plan.id, plan.price_brl);
  if (mpClient && isRecurringPlan(plan)) {
    const recurring = await createRecurringCheckout(plan, user, txId);
    return res.redirect(recurring.init_point);
  }
  if (!mpClient) {
    return res.redirect(`/pagamento/simulacao/${plan.id}?txId=${txId}`);
  }
  return res.redirect(`/checkout/${plan.id}?txId=${txId}`);
}));

// Dashboard
app.get("/dashboard", requireAuth, asyncHandler(async (req, res) => {
  const sub = await getActiveSubscription(req.user.id);
  const logs = await getUsageLogs(req.user.id);
  res.type("html").send(dashboardHtml(req.user, sub, logs, req.csrfTokenValue));
}));

// Payment — create preference
app.post("/pagamento/criar/:planId", requireAuth, paymentLimiter, requireCsrf, async (req, res) => {
  const plan = await getPlanById(req.params.planId);
  if (!plan) return res.redirect("/planos");

  const txId = await createTransaction(req.user.id, plan.id, plan.price_brl);
  if (mpClient && isRecurringPlan(plan)) {
    try {
      const recurring = await createRecurringCheckout(plan, req.user, txId);
      return res.redirect(recurring.init_point);
    } catch (err) {
      console.error("MP recurring error", err);
      return res.redirect("/planos?erro=Erro+ao+iniciar+assinatura");
    }
  }

  if (!mpClient) {
    // simulation mode
    return res.redirect(`/pagamento/simulacao/${plan.id}?txId=${txId}`);
  }

  return res.redirect(`/checkout/${plan.id}?txId=${txId}`);

  try {
    const pref = null;
    const resp = await pref.create({
      body: {
        items: [{ title: `Extrator GAN — ${plan.name}`, quantity: 1, unit_price: plan.price_brl, currency_id: "BRL" }],
        external_reference: String(txId),
        back_urls: {
          success: `${BASE_URL}/pagamento/sucesso`,
          failure: `${BASE_URL}/pagamento/falha`,
          pending: `${BASE_URL}/pagamento/pendente`,
        },
        auto_return: "approved",
        notification_url: `${BASE_URL}/pagamento/webhook`,
      }
    });
    res.redirect(resp?.init_point || "/planos?erro=Fluxo+legado+desativado");
  } catch (err) {
    console.error("MP error", err);
    res.redirect("/planos?erro=Erro+ao+iniciar+pagamento");
  }
});

// Payment — simulation page
app.get("/pagamento/simulacao/:planId", requireAuth, asyncHandler(async (req, res) => {
  const plan = await getPlanById(req.params.planId);
  if (!plan) return res.redirect("/planos");
  const txId = Number(req.query.txId);
  const tx = await getTransactionById(txId);
  if (!tx || Number(tx.user_id) !== Number(req.user.id) || String(tx.plan_id) !== String(plan.id)) {
    return res.redirect("/planos?erro=TransaÃ§Ã£o+invÃ¡lida");
  }
  res.type("html").send(simHtml(req.user, plan, txId, req.csrfTokenValue));
}));

app.post("/pagamento/simulacao/:planId", requireAuth, paymentLimiter, requireCsrf, async (req, res) => {
  const txId = Number(req.body.txId);
  if (!txId) return res.redirect("/planos?erro=Transação+inválida");
  try {
    await approveTransaction(txId, { expectedUserId: req.user.id, expectedPlanId: req.params.planId });
    res.redirect("/pagamento/sucesso");
  } catch (err) {
    res.redirect("/planos?erro=" + encodeURIComponent(err.message));
  }
});

app.get("/checkout/:planId", requireAuth, asyncHandler(async (req, res) => {
  const plan = await getPlanById(req.params.planId);
  const txId = Number(req.query.txId);
  const tx = await getTransactionById(txId);
  if (!plan || !tx || Number(tx.user_id) !== Number(req.user.id) || String(tx.plan_id) !== String(plan.id)) {
    return res.redirect("/planos?erro=Transacao+invalida");
  }
  if (!mpClient) {
    return res.redirect(`/pagamento/simulacao/${plan.id}?txId=${txId}`);
  }
  return res.type("html").send(checkoutHtml(req.user, plan, txId, req.csrfTokenValue));
}));

app.post("/pagamento/transparente/pix/:planId", requireAuth, paymentLimiter, requireCsrf, asyncHandler(async (req, res) => {
  if (!mpClient) {
    return res.status(400).json({ ok: false, erro: "Mercado Pago nao configurado." });
  }

  const plan = await getPlanById(req.params.planId);
  const txId = Number(req.body?.txId);
  const identificationNumber = String(req.body?.identificationNumber || "").replace(/\D/g, "");
  const tx = await getTransactionById(txId);

  if (!plan || !tx || Number(tx.user_id) !== Number(req.user.id) || String(tx.plan_id) !== String(plan.id)) {
    return res.status(403).json({ ok: false, erro: "Transacao invalida." });
  }
  if (tx.status === "approved") {
    return res.status(409).json({ ok: false, erro: "Esta transacao ja foi aprovada." });
  }
  if (identificationNumber.length !== 11) {
    return res.status(400).json({ ok: false, erro: "Informe um CPF valido." });
  }

  const paymentClient = new Payment(mpClient);
  const payment = await paymentClient.create({
    body: {
      transaction_amount: Number(plan.price_brl),
      description: `Extrator GAN - ${plan.name}`,
      payment_method_id: "pix",
      external_reference: String(txId),
      notification_url: buildNotificationUrl(),
      payer: buildPayerFromUser(req.user, {
        identificationType: "CPF",
        identificationNumber,
      }),
      metadata: {
        tx_id: String(txId),
        plan_id: String(plan.id),
        user_id: String(req.user.id),
      },
    },
    requestOptions: {
      idempotencyKey: `pix-${txId}`,
    },
  });

  await syncPaymentStatus(txId, payment);

  return res.json({
    ok: true,
    paymentId: String(payment.id),
    status: payment.status,
    qrCode: payment.point_of_interaction?.transaction_data?.qr_code || "",
    qrCodeBase64: payment.point_of_interaction?.transaction_data?.qr_code_base64 || "",
    ticketUrl: payment.point_of_interaction?.transaction_data?.ticket_url || "",
  });
}));

app.post("/pagamento/transparente/cartao/:planId", requireAuth, paymentLimiter, requireCsrf, asyncHandler(async (req, res) => {
  if (!mpClient) {
    return res.status(400).json({ ok: false, erro: "Mercado Pago nao configurado." });
  }

  const plan = await getPlanById(req.params.planId);
  const txId = Number(req.body?.txId);
  const tx = await getTransactionById(txId);

  if (!plan || !tx || Number(tx.user_id) !== Number(req.user.id) || String(tx.plan_id) !== String(plan.id)) {
    return res.status(403).json({ ok: false, erro: "Transacao invalida." });
  }
  if (tx.status === "approved") {
    return res.status(409).json({ ok: false, erro: "Esta transacao ja foi aprovada." });
  }

  const token = normalizeTextField(req.body?.token, 256);
  const paymentMethodId = normalizeTextField(req.body?.payment_method_id, 50);
  const installments = Number(req.body?.installments);
  const issuerId = req.body?.issuer_id ? Number(req.body.issuer_id) : undefined;
  const payer = buildPayerFromUser(req.user, req.body?.payer || {});

  if (!token || !paymentMethodId || !Number.isFinite(installments) || installments < 1) {
    return res.status(400).json({ ok: false, erro: "Dados do cartao invalidos." });
  }
  if (!payer.email || !payer.identification?.number) {
    return res.status(400).json({ ok: false, erro: "E-mail e documento do pagador sao obrigatorios." });
  }

  const paymentClient = new Payment(mpClient);
  const payment = await paymentClient.create({
    body: {
      transaction_amount: Number(plan.price_brl),
      token,
      description: `Extrator GAN - ${plan.name}`,
      installments,
      payment_method_id: paymentMethodId,
      issuer_id: issuerId,
      external_reference: String(txId),
      notification_url: buildNotificationUrl(),
      payer,
      metadata: {
        tx_id: String(txId),
        plan_id: String(plan.id),
        user_id: String(req.user.id),
      },
    },
    requestOptions: {
      idempotencyKey: `card-${txId}-${crypto.randomUUID()}`,
    },
  });

  const sync = await syncPaymentStatus(txId, payment);

  return res.json({
    ok: true,
    approved: sync.approved,
    paymentId: String(payment.id),
    status: payment.status,
    statusDetail: payment.status_detail || "",
  });
}));

app.get("/pagamento/transparente/status/:txId", requireAuth, paymentLimiter, requireCsrf, asyncHandler(async (req, res) => {
  if (!mpClient) {
    return res.status(400).json({ ok: false, erro: "Mercado Pago nao configurado." });
  }

  const txId = Number(req.params.txId);
  const paymentId = normalizeTextField(req.query.paymentId, 64);
  const tx = await getTransactionById(txId);
  if (!tx || Number(tx.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, erro: "Transacao invalida." });
  }

  const effectivePaymentId = paymentId || String(tx.mp_payment_id || "");
  if (!effectivePaymentId) {
    return res.status(400).json({ ok: false, erro: "Pagamento ainda nao foi criado." });
  }

  const paymentClient = new Payment(mpClient);
  const payment = await paymentClient.get({ id: effectivePaymentId });
  const sync = await syncPaymentStatus(txId, payment);

  return res.json({
    ok: true,
    approved: sync.approved,
    status: payment.status,
    paymentId: String(payment.id),
  });
}));

// Payment callbacks
app.get("/pagamento/sucesso", requireAuth, asyncHandler(async (req, res) => {
  const recurringTxId = Number(req.query.txId);
  const isRecurringFlow = String(req.query.recorrente || "") === "1";
  if (isRecurringFlow && recurringTxId) {
    try {
      await syncRecurringSubscriptionStatus(recurringTxId);
    } catch (err) {
      console.error("Recurring success sync error", err);
    }
  }
  const sub = await getActiveSubscription(req.user.id);
  const guestMessage = req.session?.guestCheckout
    ? `<div class="alert alert-warn" style="max-width:480px;margin-bottom:16px">
        Seu acesso já está liberado nesta sessão. Para entrar depois no mesmo e-mail, <a href="/conta/acesso" style="color:inherit;font-weight:700">defina sua senha agora</a>.
      </div>`
    : "";
  res.type("html").send(shell("Pagamento aprovado!", `
    <div class="page">
      ${guestMessage}
      <div class="alert alert-ok" style="max-width:480px">
        ✅ Pagamento aprovado! Seu plano ${sub ? `<strong>${esc(sub.plan_name)}</strong>` : ""} já está ativo.
      </div>
      <div style="display:flex;gap:10px">
        <a class="btn btn-primary" href="/">Extrair agora</a>
        <a class="btn btn-outline" href="/dashboard">Dashboard</a>
      </div>
    </div>`, req.user, sub, req.csrfTokenValue));
}));

app.get("/pagamento/pendente", requireAuth, (req, res) => {
  res.type("html").send(shell("Pagamento pendente", `
    <div class="page">
      <div class="alert alert-warn" style="max-width:480px">
        ⏳ Pagamento em análise. Assim que aprovado, seu plano será ativado automaticamente.
      </div>
      <a class="btn btn-outline" href="/dashboard">Ver dashboard</a>
    </div>`, req.user, null, req.csrfTokenValue));
});

app.get("/pagamento/falha", requireAuth, (req, res) => {
  res.type("html").send(shell("Pagamento recusado", `
    <div class="page">
      <div class="alert" style="max-width:480px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#fca5a5">
        ❌ Pagamento não aprovado. Tente novamente com outro método de pagamento.
      </div>
      <a class="btn btn-primary" href="/planos">Tentar novamente</a>
    </div>`, req.user, null, req.csrfTokenValue));
});

// Mercado Pago webhook
app.post("/pagamento/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!isMercadoPagoWebhookValid(req)) {
      return res.sendStatus(401);
    }

    const body = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString("utf8"))
      : typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;
    const type = String(body?.type || body?.topic || "").toLowerCase();

    if (type === "payment") {
      const paymentId = body?.data?.id || req.query["data.id"];
      if (!paymentId || !mpClient) return res.sendStatus(200);

      const paymentApi = new Payment(mpClient);
      const payment = await paymentApi.get({ id: paymentId });

      const txId = Number(payment.external_reference);
      if (txId) {
        await syncPaymentStatus(txId, payment);
      }
      return res.sendStatus(200);
    }

    if (type === "subscription_preapproval") {
      const preapprovalId = body?.data?.id || req.query["data.id"];
      if (!preapprovalId) return res.sendStatus(200);

      const subscription = await mercadoPagoRequest(`/preapproval/${encodeURIComponent(preapprovalId)}`);
      const txId = Number(subscription?.external_reference);
      if (txId) {
        await syncRecurringSubscriptionStatus(txId, preapprovalId);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error", err);
    res.sendStatus(200);
  }
});

// Extractor (requires auth + active plan)
app.post("/extrair", extractorLimiter, requireApiAuth, requireCsrf, upload.single("pdf"), async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, erro: "Login necessário. Acesse /login." });
    if (!req.file) return res.status(400).json({ ok: false, erro: "Nenhum arquivo enviado." });
    if (!req.file.originalname.toLowerCase().endsWith(".pdf"))
      return res.status(400).json({ ok: false, erro: "Arquivo precisa ser um PDF." });

    const sub = await getActiveSubscription(req.user.id);
    if (!sub) return res.status(402).json({ ok: false, erro: "Sem plano ativo. Acesse /planos para adquirir.", redirect: "/planos" });

    const addresses = await extractAddressesFromPdfBuffer(req.file.buffer);
    if (!addresses.length) return res.status(422).json({ ok: false, erro: "Nenhum endereço encontrado neste PDF." });

    // Consume credit if credit-based plan
    if (sub.credits_remaining !== null) {
      await consumeCredit(req.user.id, sub.id);
    }

    await logUsage(req.user.id, sub.id, req.file.originalname, addresses.length);

    return res.json({
      ok: true,
      enderecos: addresses,
      meta: {
        arquivo: req.file.originalname,
        total: addresses.length,
        bairrosVazios: addresses.filter(item => !item.bairro).length,
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message || "Erro interno ao processar o PDF." });
  }
});

// Download
app.post("/baixar/:format", downloadLimiter, requireApiAuth, requireCsrf, async (req, res) => {
  try {
    const colunas = Array.isArray(req.body?.colunas) ? req.body.colunas : ["ENDEREÇO", "BAIRRO", "CEP"];
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    const name = sanitizeDownloadName(req.body?.nome);

    if (!linhas.length) return res.status(400).json({ ok: false, erro: "Nenhum dado informado para download." });
    if (colunas.length > 10 || linhas.length > 10000) {
      return res.status(400).json({ ok: false, erro: "Arquivo acima do limite permitido." });
    }
    for (const row of linhas) {
      if (!Array.isArray(row) || row.length > 10) {
        return res.status(400).json({ ok: false, erro: "Formato de linhas invÃ¡lido." });
      }
      for (const cell of row) {
        if (String(cell ?? "").length > 512) {
          return res.status(400).json({ ok: false, erro: "ConteÃºdo acima do limite permitido." });
        }
      }
    }

    if (req.params.format === "xlsx") {
      const buffer = await generateXlsxBuffer(colunas, linhas);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
      return res.send(buffer);
    }

    if (req.params.format === "txt") {
      const buffer = generateTxtBuffer(colunas, linhas);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.txt"`);
      return res.send(buffer);
    }

    return res.status(404).json({ ok: false, erro: "Formato inválido." });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message || "Erro interno ao gerar o arquivo." });
  }
});

// Error handlers
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, erro: "Arquivo acima do limite de 50 MB." });
    return res.status(400).json({ ok: false, erro: "Falha no upload do arquivo." });
  }
  next(err);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, erro: "Erro interno do servidor." });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Extrator GAN SaaS ouvindo em http://${host}:${port}`);
});
