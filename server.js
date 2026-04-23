import express from "express";
import multer from "multer";

import { extractAddressesFromPdfBuffer, generateTxtBuffer } from "./src/extractor.js";
import { generateXlsxBuffer } from "./src/xlsx.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extrator GAN</title>
<style>
  :root {
    --bg:       #09090b;
    --s1:       #111113;
    --s2:       #18181b;
    --border:   #27272a;
    --bh:       #3f3f46;
    --t1:       #fafafa;
    --t2:       #a1a1aa;
    --t3:       #52525b;
    --rose:     #ffffff;
    --pink:     #d4d4d4;
    --accent:   #dc2626;
    --green:    #22c55e;
    --red:      #ef4444;
    --amber:    #f59e0b;
    --r:        10px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--t1);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    line-height: 1.5;
  }

  /* topbar */
  .topbar {
    height: 52px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 20px;
    gap: 12px;
    flex-shrink: 0;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 9px;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: -0.01em;
  }
  .logo-mark {
    width: 26px; height: 26px;
    border-radius: 7px;
    background: var(--accent);
    display: grid; place-items: center;
    font-size: 11px; font-weight: 800; color: #fff;
    flex-shrink: 0;
  }
  .topbar-sep { flex: 1 }
  .topbar-link {
    font-size: 13px; color: var(--t3); padding: 5px 10px;
    border-radius: var(--r); cursor: pointer; background: none; border: none;
    transition: color .15s, background .15s;
  }
  .topbar-link:hover { color: var(--t1); background: var(--s2) }
  .topbar-cta {
    font-size: 13px; font-weight: 600; padding: 6px 14px;
    border-radius: var(--r); border: none; cursor: pointer;
    background: var(--accent);
    color: #fff; transition: opacity .15s;
  }
  .topbar-cta:hover { opacity: .85 }

  /* layout */
  .page {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 56px 20px 80px;
    gap: 40px;
  }

  /* hero */
  .hero { text-align: center; max-width: 520px }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border-radius: 999px;
    background: rgba(220,38,38,.1); border: 1px solid rgba(220,38,38,.3);
    color: #fca5a5; font-size: 12px; font-weight: 700;
    letter-spacing: .05em; text-transform: uppercase; margin-bottom: 18px;
  }
  .hero h1 {
    font-size: clamp(2rem, 5vw, 3rem);
    font-weight: 800; letter-spacing: -.04em;
    line-height: 1.05; margin-bottom: 14px;
  }
  .gr {
    background: linear-gradient(135deg, #ffffff 0%, #d4d4d4 50%, #a3a3a3 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .hero p { font-size: 15px; color: var(--t2); line-height: 1.65 }

  /* upload card */
  .card {
    width: 100%; max-width: 560px;
    background: var(--s1); border: 1px solid var(--border);
    border-radius: 16px; overflow: hidden;
    border-top: 2px solid var(--accent);
  }
  .drop-zone {
    display: block; padding: 40px 28px;
    text-align: center; cursor: pointer;
    transition: background .15s; position: relative;
  }
  .drop-zone:hover, .drop-zone.over { background: var(--s2) }
  .drop-icon {
    width: 52px; height: 52px; margin: 0 auto 16px;
    border-radius: 12px; border: 1px solid var(--bh);
    display: grid; place-items: center; background: var(--s2);
  }
  .drop-icon svg { width: 22px; height: 22px; stroke: var(--t2) }
  .drop-zone b { display: block; font-size: 15px; font-weight: 600; margin-bottom: 4px }
  .drop-zone small { font-size: 13px; color: var(--t3) }
  .file-name {
    margin-top: 12px; font-size: 13px; font-weight: 600; color: #fca5a5;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  input[type=file] { display: none }
  .card-actions {
    padding: 12px 16px; border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .spacer { flex: 1 }

  /* buttons */
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: var(--r); border: none;
    font-size: 13px; font-weight: 600; cursor: pointer;
    transition: all .15s;
  }
  .btn:disabled { opacity: .35; cursor: not-allowed }
  .btn-primary {
    background: var(--accent);
    color: #fff;
  }
  .btn-primary:hover:not(:disabled) { opacity: .88; transform: translateY(-1px) }
  .btn-outline {
    background: transparent; color: var(--t2);
    border: 1px solid var(--border);
  }
  .btn-outline:hover:not(:disabled) {
    background: var(--s2); color: var(--t1); border-color: var(--bh);
    transform: translateY(-1px);
  }

  /* status */
  .status {
    width: 100%; max-width: 560px;
    display: flex; align-items: center; gap: 8px;
    min-height: 28px; font-size: 13px; color: var(--t3);
    padding: 0 4px;
  }
  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--t3); flex-shrink: 0;
  }
  .dot.ok    { background: var(--green) }
  .dot.error { background: var(--red) }
  .dot.busy  { background: var(--amber); animation: blink .9s infinite }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }
  .status.ok    { color: var(--green) }
  .status.error { color: var(--red) }

  /* results */
  .results { width: 100%; max-width: 860px }
  .results-top {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 14px; flex-wrap: wrap;
  }
  .results-top h2 { font-size: 14px; font-weight: 700 }
  .count {
    padding: 2px 9px; border-radius: 999px;
    background: rgba(220,38,38,.1); color: #fca5a5;
    font-size: 12px; font-weight: 700; border: 1px solid rgba(220,38,38,.2);
  }
  .dl-row { margin-left: auto; display: flex; gap: 6px }
  .tbl-wrap {
    border: 1px solid var(--border); border-radius: 12px;
    overflow: hidden;
  }
  .tbl-inner { overflow: auto; max-height: 65vh }
  table { width: 100%; border-collapse: collapse; font-size: 13px }
  thead th {
    padding: 10px 14px; text-align: left;
    font-size: 11px; font-weight: 700;
    letter-spacing: .07em; text-transform: uppercase;
    color: var(--t3); background: var(--s1);
    border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 1;
  }
  tbody td {
    padding: 11px 14px; border-bottom: 1px solid var(--border);
    color: var(--t2); vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: none }
  tbody tr:hover td { background: rgba(255,255,255,.02) }
  td:first-child { width: 52px; color: var(--t3); font-variant-numeric: tabular-nums }
  td:nth-child(2) { color: var(--t1) }
  td:nth-child(3) { font-family: ui-monospace, monospace }
  .chip {
    display: inline-block; padding: 3px 9px; border-radius: 6px; font-size: 12px; font-weight: 600;
    background: rgba(34,197,94,.1); color: #86efac; border: 1px solid rgba(34,197,94,.12);
  }
  .chip.empty { background: rgba(113,113,122,.1); color: var(--t3); border-color: transparent; font-style: italic }

  /* footer */
  footer {
    border-top: 1px solid var(--border); padding: 20px 24px;
    text-align: center; font-size: 12px; color: var(--t3);
  }
  footer a { color: var(--t3) }
  footer a:hover { color: var(--t2) }

  @media (max-width: 600px) {
    .page { padding: 32px 12px 60px }
    .card, .status, .results { max-width: 100% }
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="logo"><div class="logo-mark">EG</div>Extrator GAN</div>
  <div class="topbar-sep"></div>
  <button class="topbar-link">Planos</button>
  <button class="topbar-cta">Entrar</button>
</div>
<div class="page">
  <div class="hero">
    <div class="pill">&#x2736; Extrator de endere&#xE7;os</div>
    <h1>Transforme PDFs em<br><span class="gr">dados prontos</span></h1>
    <p>Fa&#xE7;a upload da lista GAN e exporte os endere&#xE7;os em Excel ou TXT em segundos.</p>
  </div>
  <div class="card">
    <label class="drop-zone" id="drop">
      <div class="drop-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      </div>
      <b>Arraste o PDF aqui ou clique para escolher</b>
      <small>Listas GAN &middot; m&#xE1;ximo 50 MB</small>
      <div class="file-name" id="fileName"></div>
      <input id="pdf" type="file" accept=".pdf">
    </label>
    <div class="card-actions">
      <button id="extractBtn" class="btn btn-primary" disabled>Extrair endere&#xE7;os</button>
      <div class="spacer"></div>
      <button id="dlXlsx" class="btn btn-outline" disabled>&#x2193; Excel</button>
      <button id="dlTxt" class="btn btn-outline" disabled>&#x2193; TXT</button>
    </div>
  </div>
  <div class="status" id="status">
    <div class="dot" id="dot"></div>
    <span id="statusText">Aguardando arquivo</span>
  </div>
  <div class="results" id="results" hidden>
    <div class="results-top">
      <h2>Endere&#xE7;os extra&#xED;dos</h2>
      <span class="count" id="count">0</span>
      <div class="dl-row">
        <button id="dlXlsx2" class="btn btn-outline">&#x2193; Excel</button>
        <button id="dlTxt2" class="btn btn-outline">&#x2193; TXT</button>
      </div>
    </div>
    <div class="tbl-wrap"><div class="tbl-inner">
      <table>
        <thead><tr><th>#</th><th>Endere&#xE7;o</th><th>CEP</th><th>Bairro</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div></div>
  </div>
</div>
<footer>Extrator GAN &middot; Elias Samuel &middot; <a href="https://github.com/Eli2s">github.com/Eli2s</a></footer>
<script>
  let file = null, result = null, baseName = "enderecos";
  const drop       = document.getElementById("drop");
  const input      = document.getElementById("pdf");
  const fileName   = document.getElementById("fileName");
  const status     = document.getElementById("status");
  const dot        = document.getElementById("dot");
  const statusText = document.getElementById("statusText");
  const extractBtn = document.getElementById("extractBtn");
  const dlXlsx     = document.getElementById("dlXlsx");
  const dlTxt      = document.getElementById("dlTxt");
  const dlXlsx2    = document.getElementById("dlXlsx2");
  const dlTxt2     = document.getElementById("dlTxt2");
  const results    = document.getElementById("results");
  const tbody      = document.getElementById("tbody");
  const count      = document.getElementById("count");

  function setStatus(msg, tone) {
    statusText.textContent = msg;
    dot.className    = "dot"    + (tone ? " " + tone : "");
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
    result = null;
    results.hidden = true;
    tbody.replaceChildren();
    count.textContent = "0";
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
    setBusy(true);
    setStatus("Processando PDF…", "busy");
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
    setBusy(true);
    setStatus("Gerando " + fmt.toUpperCase() + "…", "busy");
    try {
      const res = await fetch("/baixar/" + fmt, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enderecos: result, nome: baseName })
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

  dlXlsx.addEventListener("click",  () => download("xlsx"));
  dlXlsx2.addEventListener("click", () => download("xlsx"));
  dlTxt.addEventListener("click",   () => download("txt"));
  dlTxt2.addEventListener("click",  () => download("txt"));
</script>
</body>
</html>`;

function sanitizeDownloadName(name) {
  return String(name || "enderecos")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "enderecos";
}

app.get("/", (req, res) => {
  res.type("html").send(html);
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, runtime: "node", service: "extrator-enderecos-node-port" });
});

app.post("/extrair", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, erro: "Nenhum arquivo enviado." });
    }
    if (!req.file.originalname.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ ok: false, erro: "Arquivo precisa ser um PDF." });
    }

    const addresses = await extractAddressesFromPdfBuffer(req.file.buffer);
    if (!addresses.length) {
      return res.status(422).json({ ok: false, erro: "Nenhum endereco encontrado neste PDF." });
    }

    return res.json({
      ok: true,
      enderecos: addresses,
      meta: {
        arquivo: req.file.originalname,
        total: addresses.length,
        bairrosVazios: addresses.filter((item) => !item.bairro).length
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, erro: error.message || "Erro interno ao processar o PDF." });
  }
});

app.post("/baixar/:format", async (req, res) => {
  try {
    const addresses = Array.isArray(req.body?.enderecos) ? req.body.enderecos : [];
    const name = sanitizeDownloadName(req.body?.nome);

    if (!addresses.length) {
      return res.status(400).json({ ok: false, erro: "Nenhum endereco informado para download." });
    }

    if (req.params.format === "xlsx") {
      const buffer = await generateXlsxBuffer(addresses);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
      return res.send(buffer);
    }

    if (req.params.format === "txt") {
      const buffer = generateTxtBuffer(addresses);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.txt"`);
      return res.send(buffer);
    }

    return res.status(404).json({ ok: false, erro: "Formato de download invalido." });
  } catch (error) {
    return res.status(500).json({ ok: false, erro: error.message || "Erro interno ao gerar o arquivo." });
  }
});

app.use((error, req, res, next) => {
  if (!(error instanceof multer.MulterError)) {
    return next(error);
  }

  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, erro: "Arquivo acima do limite de 50 MB." });
  }

  return res.status(400).json({ ok: false, erro: "Falha no upload do arquivo." });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ ok: false, erro: "Erro interno do servidor." });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

app.listen(port, host, () => {
  console.log(`Extrator Node ouvindo em http://${host}:${port}`);
});
