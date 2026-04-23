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
  <title>Extrator de Enderecos GAN</title>
  <style>
    :root {
      --bg: #08111f;
      --bg-deep: #050a14;
      --surface: rgba(10, 18, 33, 0.74);
      --surface-strong: rgba(12, 22, 39, 0.9);
      --surface-soft: rgba(255, 255, 255, 0.06);
      --line: rgba(148, 163, 184, 0.18);
      --text: #edf4ff;
      --muted: #9db0c8;
      --brand: #24c8a5;
      --brand-2: #4f7cff;
      --brand-3: #f973b0;
      --green: #38d39f;
      --red: #ff7b8b;
      --amber: #ffcd6b;
      --shadow: 0 28px 70px rgba(0, 0, 0, 0.34);
      --radius-xl: 28px;
      --radius-lg: 22px;
      --radius-md: 16px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      font-family: "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 12% 18%, rgba(79,124,255,0.24), transparent 24%),
        radial-gradient(circle at 88% 16%, rgba(249,115,176,0.18), transparent 22%),
        radial-gradient(circle at 82% 80%, rgba(36,200,165,0.16), transparent 22%),
        linear-gradient(145deg, var(--bg-deep) 0%, var(--bg) 52%, #0a1629 100%);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
      background-size: 44px 44px;
      mask-image: radial-gradient(circle at center, black 38%, transparent 90%);
      opacity: 0.22;
    }
    .wrap {
      position: relative;
      max-width: 1180px;
      margin: 0 auto;
      padding: 38px 18px 70px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 18px;
      margin-bottom: 22px;
      flex-wrap: wrap;
    }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      gap: 14px;
    }
    .brand-badge {
      width: 46px;
      height: 46px;
      border-radius: 16px;
      display: grid;
      place-items: center;
      font-weight: 800;
      letter-spacing: 0.04em;
      color: #04111d;
      background: linear-gradient(135deg, var(--brand) 0%, #76ffd7 100%);
      box-shadow: 0 14px 34px rgba(36,200,165,0.3);
    }
    .brand-copy strong {
      display: block;
      font-size: 1rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .brand-copy span {
      display: block;
      color: var(--muted);
      font-size: 0.88rem;
      margin-top: 3px;
    }
    .topbar-note {
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--muted);
      font-size: 0.88rem;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.12fr 0.88fr;
      gap: 18px;
      margin-bottom: 22px;
    }
    .panel {
      background: var(--surface);
      backdrop-filter: blur(20px);
      border: 1px solid var(--line);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow);
    }
    .hero-main {
      position: relative;
      overflow: hidden;
      padding: 34px;
      background:
        linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02)),
        linear-gradient(160deg, rgba(79,124,255,0.16), rgba(10,18,33,0.18) 42%, rgba(36,200,165,0.08));
    }
    .hero-main::after {
      content: "";
      position: absolute;
      width: 260px;
      height: 260px;
      border-radius: 999px;
      right: -60px;
      top: -60px;
      background: radial-gradient(circle, rgba(79,124,255,0.26), transparent 68%);
      pointer-events: none;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 13px;
      border-radius: 999px;
      background: rgba(36,200,165,0.12);
      color: #7ef4d7;
      border: 1px solid rgba(36,200,165,0.18);
      font-size: 0.81rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    h1 {
      margin-top: 18px;
      font-size: clamp(2.3rem, 5vw, 4.4rem);
      line-height: 0.92;
      letter-spacing: -0.05em;
      max-width: 11ch;
    }
    h1 .gradient {
      display: block;
      background: linear-gradient(90deg, #ffffff 0%, #8fe9ff 44%, #88ffdc 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .sub {
      margin-top: 18px;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.65;
      max-width: 58ch;
    }
    .hero-cards {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 24px;
    }
    .mini-card {
      min-width: 140px;
      padding: 14px 16px;
      border-radius: 18px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .mini-card strong {
      display: block;
      font-size: 1.1rem;
      margin-bottom: 4px;
    }
    .mini-card span {
      color: var(--muted);
      font-size: 0.84rem;
    }
    .hero-side {
      padding: 28px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 18px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)),
        var(--surface-strong);
    }
    .hero-side h2 {
      font-size: 1.06rem;
      margin-bottom: 14px;
    }
    .meta-list {
      display: grid;
      gap: 12px;
    }
    .meta-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px 16px;
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .meta-item:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .meta-item span:first-child { color: var(--muted); }
    .meta-item strong { text-align: right; }
    .hero-callout {
      padding: 16px 18px;
      border-radius: 18px;
      background: linear-gradient(135deg, rgba(249,115,176,0.14), rgba(79,124,255,0.16));
      border: 1px solid rgba(255,255,255,0.1);
      color: #dbe7ff;
      line-height: 1.55;
      font-size: 0.9rem;
    }
    .app {
      padding: 22px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)),
        var(--surface);
    }
    .drop {
      display: block;
      position: relative;
      overflow: hidden;
      padding: 36px 24px;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 24px;
      background:
        radial-gradient(circle at top right, rgba(79,124,255,0.22), transparent 28%),
        radial-gradient(circle at bottom left, rgba(36,200,165,0.16), transparent 24%),
        linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03));
      text-align: center;
      cursor: pointer;
      transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease;
    }
    .drop.hover {
      border-color: rgba(36,200,165,0.42);
      transform: translateY(-2px);
      box-shadow: 0 20px 40px rgba(0,0,0,0.24);
    }
    .drop-icon {
      width: 78px;
      height: 78px;
      margin: 0 auto 16px;
      border-radius: 24px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, rgba(79,124,255,0.28), rgba(36,200,165,0.28));
      color: white;
      font-size: 1.35rem;
      font-weight: 800;
      letter-spacing: 0.05em;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.24);
    }
    .drop strong {
      font-size: 1.16rem;
      display: block;
    }
    .drop small {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .file {
      margin-top: 16px;
      color: #9df4de;
      font-size: 0.95rem;
      font-weight: 700;
      word-break: break-word;
    }
    input[type=file] { display: none; }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      margin-top: 18px;
      flex-wrap: wrap;
    }
    .actions,
    .summary {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button {
      border: 0;
      border-radius: 16px;
      padding: 13px 18px;
      font-weight: 800;
      font-size: 0.95rem;
      cursor: pointer;
      transition: transform .15s ease, opacity .15s ease, box-shadow .2s ease, background .2s ease;
    }
    button:hover:not(:disabled) { transform: translateY(-1px); }
    button:disabled { opacity: .45; cursor: not-allowed; transform: none; box-shadow: none; }
    .primary {
      background: linear-gradient(135deg, var(--brand) 0%, var(--brand-2) 100%);
      color: #04111d;
      box-shadow: 0 18px 32px rgba(36,200,165,0.2);
    }
    .primary:hover:not(:disabled) {
      background: linear-gradient(135deg, #52f0cb 0%, #79a5ff 100%);
    }
    .secondary {
      background: rgba(255,255,255,0.07);
      color: var(--text);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .secondary:hover:not(:disabled) {
      background: rgba(255,255,255,0.13);
    }
    .pill {
      border-radius: 999px;
      padding: 10px 14px;
      font-size: 0.87rem;
      background: rgba(255,255,255,0.07);
      color: var(--muted);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .status {
      min-height: 24px;
      margin-top: 14px;
      font-size: 0.95rem;
      color: var(--muted);
    }
    .status.error { color: var(--red); }
    .status.ok { color: var(--green); }
    .status.warn { color: var(--amber); }
    .results {
      margin-top: 22px;
      border-radius: 24px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.1);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02)),
        rgba(8,17,31,0.65);
    }
    .results[hidden] { display: none; }
    .results-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 18px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
    }
    .results-head h2 { font-size: 1rem; }
    .results-head p { color: var(--muted); font-size: 0.9rem; margin-top: 4px; }
    .table-wrap { overflow: auto; max-height: 62vh; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: rgba(8,17,31,0.96);
      color: #8ca3c2;
      font-size: 0.8rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    tbody tr:hover {
      background: rgba(255,255,255,0.03);
    }
    td:nth-child(1), td:nth-child(3) { white-space: nowrap; }
    td:nth-child(1) {
      width: 60px;
      color: #7f92ab;
      font-variant-numeric: tabular-nums;
    }
    .bairro-chip {
      display: inline-flex;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(36,200,165,0.14);
      color: #8af0d5;
      border: 1px solid rgba(36,200,165,0.14);
      font-size: 0.83rem;
      font-weight: 700;
    }
    .empty {
      color: #ffc98e;
      background: rgba(255, 172, 83, 0.12);
      border-color: rgba(255, 172, 83, 0.14);
      font-style: italic;
    }
    @media (max-width: 920px) {
      .hero { grid-template-columns: 1fr; }
      .hero-main, .hero-side, .app { padding: 22px; }
      h1 { max-width: none; }
      .results-head { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <div class="brand-mark">
        <div class="brand-badge">EX</div>
        <div class="brand-copy">
          <strong>Extrator GAN</strong>
          <span>Node edition para publicacao rapida</span>
        </div>
      </div>
      <div class="topbar-note">PDF para TXT e Excel em uma tela so</div>
    </header>

    <section class="hero">
      <div class="panel hero-main">
        <span class="eyebrow">Extracao em foco</span>
        <h1>Suba o PDF e <span class="gradient">gere sua base</span></h1>
        <p class="sub">Versao enxuta e pronta para hospedagem Node. O app foi desenhado para ir direto ao ponto: receber a lista GAN, extrair os enderecos e devolver os dados prontos para baixar.</p>
        <div class="hero-cards">
          <div class="mini-card"><strong>50 MB</strong><span>Tamanho maximo por arquivo</span></div>
          <div class="mini-card"><strong>2 saídas</strong><span>Excel e TXT no mesmo fluxo</span></div>
          <div class="mini-card"><strong>1 tela</strong><span>Interface direta para operacao</span></div>
        </div>
      </div>
      <aside class="panel hero-side">
        <div>
          <h2>Painel de status</h2>
          <div class="meta-list">
            <div class="meta-item"><span>Entrada</span><strong>PDF GAN</strong></div>
            <div class="meta-item"><span>Modo atual</span><strong>Captura agressiva</strong></div>
            <div class="meta-item"><span>Saida</span><strong>Endereco, CEP, Bairro</strong></div>
            <div class="meta-item"><span>Check</span><strong>/healthz</strong></div>
          </div>
        </div>
        <div class="hero-callout">Se alguma linha vier com bairro vazio ou texto estranho, isso tende a refletir a estrutura do PDF original. Ainda assim, o app preserva o resultado para revisao e download.</div>
      </aside>
    </section>

    <section class="panel app">
      <label class="drop" id="drop">
        <div class="drop-icon">PDF</div>
        <strong>Arraste o arquivo aqui ou clique para escolher</strong>
        <small>Use listas GAN reais para validar a extracao antes de expandir o restante do produto.</small>
        <div class="file" id="fileName"></div>
        <input id="pdf" type="file" accept=".pdf">
      </label>

      <div class="toolbar">
        <div class="actions">
          <button id="extractBtn" class="primary" disabled>Extrair agora</button>
          <button id="xlsxBtn" class="secondary" disabled>Baixar XLSX</button>
          <button id="txtBtn" class="secondary" disabled>Baixar TXT</button>
        </div>
        <div class="summary">
          <span class="pill" id="countPill">0 enderecos</span>
          <span class="pill" id="qualityPill">Aguardando arquivo</span>
        </div>
      </div>

      <div class="status" id="status"></div>

      <div class="results" id="results" hidden>
        <div class="results-head">
          <div>
            <h2>Resultado da extracao</h2>
            <p id="resultsMeta">Nenhum resultado carregado.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Endereco</th><th>CEP</th><th>Bairro</th></tr>
            </thead>
            <tbody id="tbody"></tbody>
          </table>
        </div>
      </div>
    </section>
  </div>

  <script>
    let file = null;
    let result = null;
    let baseName = "enderecos";

    const drop = document.getElementById("drop");
    const input = document.getElementById("pdf");
    const fileName = document.getElementById("fileName");
    const status = document.getElementById("status");
    const extractBtn = document.getElementById("extractBtn");
    const xlsxBtn = document.getElementById("xlsxBtn");
    const txtBtn = document.getElementById("txtBtn");
    const results = document.getElementById("results");
    const tbody = document.getElementById("tbody");
    const countPill = document.getElementById("countPill");
    const qualityPill = document.getElementById("qualityPill");
    const resultsMeta = document.getElementById("resultsMeta");

    function setStatus(message, tone) {
      status.className = "status" + (tone ? " " + tone : "");
      status.textContent = message;
    }

    function setBusyState(isBusy) {
      extractBtn.disabled = !file || isBusy;
      xlsxBtn.disabled = !result || isBusy;
      txtBtn.disabled = !result || isBusy;
    }

    function setFile(nextFile) {
      file = nextFile;
      baseName = nextFile.name.replace(/\\.pdf$/i, "") || "enderecos";
      fileName.textContent = nextFile.name;
      result = null;
      results.hidden = true;
      tbody.replaceChildren();
      countPill.textContent = "0 enderecos";
      qualityPill.textContent = "Pronto para extrair";
      resultsMeta.textContent = "Nenhum resultado carregado.";
      setStatus("");
      setBusyState(false);
    }

    function renderRows(items) {
      const fragment = document.createDocumentFragment();
      for (const [index, item] of items.entries()) {
        const tr = document.createElement("tr");
        const columns = [
          String(index + 1),
          item.endereco || "",
          item.cep || "",
          item.bairro || ""
        ];

        columns.forEach((value, columnIndex) => {
          const td = document.createElement("td");
          if (columnIndex === 3) {
            const span = document.createElement("span");
            span.className = "bairro-chip" + (!value ? " empty" : "");
            span.textContent = value || "Bairro vazio";
            td.appendChild(span);
          } else {
            td.textContent = value;
          }
          tr.appendChild(td);
        });

        fragment.appendChild(tr);
      }

      tbody.replaceChildren(fragment);
    }

    function setSummary(items) {
      const emptyBairros = items.filter((item) => !item.bairro).length;
      countPill.textContent = items.length + " enderecos";
      qualityPill.textContent = emptyBairros === 0
        ? "Sem bairros vazios"
        : emptyBairros + " com bairro vazio";
      resultsMeta.textContent = emptyBairros === 0
        ? "Extracao concluida e pronta para download."
        : "Extracao concluida. Revise principalmente as linhas com bairro vazio.";
    }

    input.addEventListener("change", () => {
      if (input.files[0]) {
        setFile(input.files[0]);
      }
    });

    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("hover");
    });

    drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("hover");
      const dropped = event.dataTransfer.files[0];
      if (dropped && dropped.name.toLowerCase().endsWith(".pdf")) {
        setFile(dropped);
      }
    });

    extractBtn.addEventListener("click", async () => {
      if (!file) return;

      setBusyState(true);
      setStatus("Processando PDF...", "warn");
      const form = new FormData();
      form.append("pdf", file);

      try {
        const response = await fetch("/extrair", { method: "POST", body: form });
        const data = await response.json();
        if (!data.ok) throw new Error(data.erro);

        result = data.enderecos;
        renderRows(result);
        setSummary(result);
        results.hidden = false;
        setStatus("Extracao concluida com sucesso.", "ok");
      } catch (error) {
        setStatus("Erro: " + error.message, "error");
      } finally {
        setBusyState(false);
      }
    });

    async function download(format) {
      if (!result) return;

      setBusyState(true);
      setStatus("Gerando arquivo " + format.toUpperCase() + "...", "warn");
      try {
        const response = await fetch("/baixar/" + format, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enderecos: result, nome: baseName })
        });
        if (!response.ok) {
          throw new Error("Falha ao gerar download.");
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = baseName + (format === "xlsx" ? ".xlsx" : ".txt");
        anchor.click();
        URL.revokeObjectURL(url);
        setStatus("Download pronto.", "ok");
      } catch (error) {
        setStatus("Erro: " + error.message, "error");
      } finally {
        setBusyState(false);
      }
    }

    xlsxBtn.addEventListener("click", () => download("xlsx"));
    txtBtn.addEventListener("click", () => download("txt"));
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
