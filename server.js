import express from "express";
import multer from "multer";
import session from "express-session";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

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
} from "./src/db.js";
import { createUser, loginUser, getUserById, requireAuth } from "./src/auth.js";


const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", maxAge: 7 * 86400000 },
}));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
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

// Mercado Pago
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const mpClient = MP_TOKEN ? new MercadoPagoConfig({ accessToken: MP_TOKEN }) : null;

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
function topbar(user, sub) {
  const right = user
    ? `<a class="topbar-link" href="/planos">Planos</a>
       <a class="topbar-link" href="/dashboard">${esc(user.name || user.email)}</a>
       <form method="POST" action="/auth/logout" style="display:inline">
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

function shell(title, body, user, sub) {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Extrator GAN</title>
<style>${CSS}</style></head><body>
${topbar(user, sub)}
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
      <a class="btn btn-outline" href="/register">Criar conta grátis</a>
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
function toolHtml(user, sub) {
  const credInfo = sub
    ? sub.credits_remaining !== null
      ? `<span class="badge badge-ok">${sub.credits_remaining} crédito${sub.credits_remaining !== 1 ? "s" : ""}</span>`
      : `<span class="badge badge-ok">Ilimitado até ${sub.expires_at ? sub.expires_at.slice(0, 10) : "—"}</span>`
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
      const res = await fetch("/extrair", { method: "POST", body: form });
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
        headers: { "Content-Type": "application/json" },
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
</script>`, user, sub);
}

// ── Page: Login ────────────────────────────────────────────────────────────────
function loginHtml(error, ok) {
  return shell("Entrar", `
  <div class="form-page">
    <div class="form-card">
      <h1>Entrar</h1>
      <p class="sub">Acesse sua conta para extrair endereços.</p>
      ${error ? `<div class="form-error">${esc(error)}</div>` : ""}
      ${ok ? `<div class="form-ok">${esc(ok)}</div>` : ""}
      <form method="POST" action="/auth/login">
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
      <p class="form-foot">Não tem conta? <a href="/register">Criar conta</a></p>
    </div>
  </div>`, null, null);
}

// ── Page: Register ─────────────────────────────────────────────────────────────
function registerHtml(error) {
  return shell("Criar Conta", `
  <div class="form-page">
    <div class="form-card">
      <h1>Criar conta</h1>
      <p class="sub">Crie sua conta e comece a extrair.</p>
      ${error ? `<div class="form-error">${esc(error)}</div>` : ""}
      <form method="POST" action="/auth/register">
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
  </div>`, null, null);
}

// ── Page: Planos ───────────────────────────────────────────────────────────────
function planosHtml(user, sub, plans) {
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
             <button type="submit" class="btn ${featured ? "btn-primary" : "btn-outline"}" style="width:100%;justify-content:center">Comprar</button>
           </form>`
        : `<a class="btn ${featured ? "btn-primary" : "btn-outline"}" href="/register" style="justify-content:center;display:flex">Criar conta</a>`
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
  </div>`, user, sub);
}

// ── Page: Dashboard ────────────────────────────────────────────────────────────
function dashboardHtml(user, sub, logs) {
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
      ? sub.expires_at.slice(0, 10)
      : "Sem validade"
    : "—";

  const logRows = logs.length
    ? logs.map((l, i) => `<tr>
        <td>${String(i + 1)}</td>
        <td>${esc(l.filename || "—")}</td>
        <td>${String(l.extracted_count)}</td>
        <td>${esc(l.plan_name || "—")}</td>
        <td>${String(l.used_at).slice(0, 16).replace("T", " ")}</td>
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
  </div>`, user, sub);
}

// ── Page: Simulação pagamento ──────────────────────────────────────────────────
function simHtml(user, plan, txId) {
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
        <input type="hidden" name="txId" value="${esc(String(txId))}">
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">✓ Aprovar pagamento (teste)</button>
      </form>
      <p class="form-foot" style="margin-top:12px"><a href="/planos">Cancelar</a></p>
    </div>
  </div>`, user, null);
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function sanitizeDownloadName(name) {
  return String(name || "enderecos")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "enderecos";
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
      </div>`, user, null));
  }
  return res.type("html").send(toolHtml(user, sub));
}));

// Auth
app.get("/login", (req, res) => {
  if (req.user) return res.redirect("/");
  res.type("html").send(loginHtml(req.query.erro, req.query.ok));
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.type("html").send(loginHtml("Preencha todos os campos."));
    const user = await loginUser(email, password);
    req.session.userId = user.id;
    const sub = await getActiveSubscription(user.id);
    res.redirect(sub ? "/" : "/planos");
  } catch (err) {
    res.type("html").send(loginHtml(err.message));
  }
});

app.get("/register", (req, res) => {
  if (req.user) return res.redirect("/");
  res.type("html").send(registerHtml(req.query.erro));
});

app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.type("html").send(registerHtml("Preencha todos os campos."));
    if (password.length < 8) return res.type("html").send(registerHtml("A senha deve ter ao menos 8 caracteres."));
    const user = await createUser(email, password, name);
    req.session.userId = user.id;
    res.redirect("/planos");
  } catch (err) {
    res.type("html").send(registerHtml(err.message));
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const sub = await getActiveSubscription(req.user.id);
  res.json({ ok: true, user: req.user, subscription: sub || null });
}));

// Plans
app.get("/planos", asyncHandler(async (req, res) => {
  const plans = await getPlans();
  const sub = req.user ? await getActiveSubscription(req.user.id) : null;
  res.type("html").send(planosHtml(req.user, sub, plans));
}));

// Dashboard
app.get("/dashboard", requireAuth, asyncHandler(async (req, res) => {
  const sub = await getActiveSubscription(req.user.id);
  const logs = await getUsageLogs(req.user.id);
  res.type("html").send(dashboardHtml(req.user, sub, logs));
}));

// Payment — create preference
app.post("/pagamento/criar/:planId", requireAuth, async (req, res) => {
  const plan = await getPlanById(req.params.planId);
  if (!plan) return res.redirect("/planos");

  const txId = await createTransaction(req.user.id, plan.id, plan.price_brl);

  if (!mpClient) {
    // simulation mode
    return res.redirect(`/pagamento/simulacao/${plan.id}?txId=${txId}`);
  }

  try {
    const pref = new Preference(mpClient);
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
    res.redirect(resp.init_point);
  } catch (err) {
    console.error("MP error", err);
    res.redirect("/planos?erro=Erro+ao+iniciar+pagamento");
  }
});

// Payment — simulation page
app.get("/pagamento/simulacao/:planId", requireAuth, asyncHandler(async (req, res) => {
  const plan = await getPlanById(req.params.planId);
  if (!plan) return res.redirect("/planos");
  const txId = req.query.txId;
  res.type("html").send(simHtml(req.user, plan, txId));
}));

app.post("/pagamento/simulacao/:planId", requireAuth, async (req, res) => {
  const txId = Number(req.body.txId);
  if (!txId) return res.redirect("/planos?erro=Transação+inválida");
  try {
    await approveTransaction(txId);
    res.redirect("/pagamento/sucesso");
  } catch (err) {
    res.redirect("/planos?erro=" + encodeURIComponent(err.message));
  }
});

// Payment callbacks
app.get("/pagamento/sucesso", requireAuth, asyncHandler(async (req, res) => {
  const sub = await getActiveSubscription(req.user.id);
  res.type("html").send(shell("Pagamento aprovado!", `
    <div class="page">
      <div class="alert alert-ok" style="max-width:480px">
        ✅ Pagamento aprovado! Seu plano ${sub ? `<strong>${esc(sub.plan_name)}</strong>` : ""} já está ativo.
      </div>
      <div style="display:flex;gap:10px">
        <a class="btn btn-primary" href="/">Extrair agora</a>
        <a class="btn btn-outline" href="/dashboard">Dashboard</a>
      </div>
    </div>`, req.user, sub));
}));

app.get("/pagamento/pendente", requireAuth, (req, res) => {
  res.type("html").send(shell("Pagamento pendente", `
    <div class="page">
      <div class="alert alert-warn" style="max-width:480px">
        ⏳ Pagamento em análise. Assim que aprovado, seu plano será ativado automaticamente.
      </div>
      <a class="btn btn-outline" href="/dashboard">Ver dashboard</a>
    </div>`, req.user, null));
});

app.get("/pagamento/falha", requireAuth, (req, res) => {
  res.type("html").send(shell("Pagamento recusado", `
    <div class="page">
      <div class="alert" style="max-width:480px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#fca5a5">
        ❌ Pagamento não aprovado. Tente novamente com outro método de pagamento.
      </div>
      <a class="btn btn-primary" href="/planos">Tentar novamente</a>
    </div>`, req.user, null));
});

// Mercado Pago webhook
app.post("/pagamento/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (body?.type !== "payment") return res.sendStatus(200);

    const paymentId = body?.data?.id;
    if (!paymentId || !mpClient) return res.sendStatus(200);

    const paymentApi = new Payment(mpClient);
    const payment = await paymentApi.get({ id: paymentId });

    if (payment.status === "approved") {
      const txId = Number(payment.external_reference);
      if (txId) await approveTransaction(txId, String(paymentId));
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error", err);
    res.sendStatus(200);
  }
});

// Extractor (requires auth + active plan)
app.post("/extrair", upload.single("pdf"), async (req, res) => {
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
app.post("/baixar/:format", async (req, res) => {
  try {
    const colunas = Array.isArray(req.body?.colunas) ? req.body.colunas : ["ENDEREÇO", "BAIRRO", "CEP"];
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    const name = sanitizeDownloadName(req.body?.nome);

    if (!linhas.length) return res.status(400).json({ ok: false, erro: "Nenhum dado informado para download." });

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
