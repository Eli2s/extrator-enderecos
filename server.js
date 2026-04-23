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
      --bg: #f4efe7;
      --bg-accent: #efe2c8;
      --panel: rgba(255,255,255,0.78);
      --panel-strong: rgba(255,255,255,0.92);
      --text: #1f1a17;
      --muted: #6b6158;
      --line: rgba(67, 46, 23, 0.12);
      --brand: #be5b2a;
      --brand-dark: #8f3f18;
      --green: #1d7a46;
      --red: #b73737;
      --shadow: 0 20px 50px rgba(73, 44, 16, 0.12);
      --radius: 24px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      font-family: "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(190,91,42,0.16), transparent 28%),
        radial-gradient(circle at bottom right, rgba(137,91,45,0.16), transparent 26%),
        linear-gradient(135deg, var(--bg) 0%, #fbf7ef 48%, var(--bg-accent) 100%);
    }
    .wrap {
      max-width: 1120px;
      margin: 0 auto;
      padding: 40px 18px 72px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 18px;
      margin-bottom: 22px;
    }
    .panel {
      background: var(--panel);
      backdrop-filter: blur(16px);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .hero-main {
      padding: 32px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(190, 91, 42, 0.1);
      color: var(--brand-dark);
      font-size: 0.84rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    h1 {
      margin-top: 16px;
      font-size: clamp(2rem, 4vw, 3.4rem);
      line-height: 0.96;
      letter-spacing: -0.04em;
      max-width: 10ch;
    }
    .sub {
      margin-top: 16px;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.6;
      max-width: 58ch;
    }
    .hero-side {
      padding: 28px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 18px;
      background:
        linear-gradient(160deg, rgba(190,91,42,0.1), rgba(255,255,255,0.9)),
        var(--panel-strong);
    }
    .meta-list {
      display: grid;
      gap: 12px;
    }
    .meta-item {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }
    .meta-item:last-child { border-bottom: 0; padding-bottom: 0; }
    .meta-item span:first-child { color: var(--muted); }
    .meta-item strong { text-align: right; }
    .app {
      padding: 22px;
    }
    .drop {
      display: block;
      padding: 34px 24px;
      border: 2px dashed rgba(190, 91, 42, 0.25);
      border-radius: 20px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.56));
      text-align: center;
      cursor: pointer;
      transition: border-color .2s ease, transform .2s ease, background .2s ease;
    }
    .drop.hover {
      border-color: var(--brand);
      background: rgba(255,255,255,0.96);
      transform: translateY(-1px);
    }
    .drop-icon {
      width: 68px;
      height: 68px;
      margin: 0 auto 14px;
      border-radius: 18px;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, rgba(190,91,42,0.18), rgba(190,91,42,0.06));
      color: var(--brand-dark);
      font-size: 1.8rem;
      font-weight: 700;
    }
    .drop strong {
      font-size: 1.12rem;
      display: block;
    }
    .drop small {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .file {
      margin-top: 14px;
      color: var(--brand-dark);
      font-size: 0.94rem;
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
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button {
      border: 0;
      border-radius: 14px;
      padding: 13px 18px;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      transition: transform .15s ease, opacity .15s ease, background .2s ease;
    }
    button:hover:not(:disabled) { transform: translateY(-1px); }
    button:disabled { opacity: .45; cursor: not-allowed; transform: none; }
    .primary { background: var(--brand); color: #fff; }
    .primary:hover:not(:disabled) { background: var(--brand-dark); }
    .secondary { background: #2e2a27; color: #fff; }
    .secondary:hover:not(:disabled) { background: #1f1c1a; }
    .summary {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pill {
      border-radius: 999px;
      padding: 9px 14px;
      font-size: 0.88rem;
      background: rgba(31, 26, 23, 0.06);
      color: var(--muted);
    }
    .status {
      min-height: 24px;
      margin-top: 14px;
      font-size: 0.95rem;
      color: var(--muted);
    }
    .status.error { color: var(--red); }
    .status.ok { color: var(--green); }
    .status.warn { color: var(--brand-dark); }
    .results {
      margin-top: 22px;
      border-radius: 20px;
      overflow: hidden;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.72);
    }
    .results[hidden] { display: none; }
    .results-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,0.7);
    }
    .results-head h2 { font-size: 1rem; }
    .results-head p { color: var(--muted); font-size: 0.9rem; margin-top: 4px; }
    .table-wrap { overflow: auto; max-height: 62vh; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(67,46,23,0.08);
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: rgba(248, 242, 233, 0.96);
      color: var(--muted);
      font-size: 0.82rem;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    td:nth-child(1), td:nth-child(3) { white-space: nowrap; }
    td:nth-child(1) {
      width: 60px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .bairro-chip {
      display: inline-flex;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(29,122,70,0.1);
      color: #155a34;
      font-size: 0.84rem;
      font-weight: 700;
    }
    .empty {
      font-style: italic;
      color: #97715b;
      background: rgba(190,91,42,0.08);
    }
    .footnote {
      margin-top: 14px;
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.5;
    }
    @media (max-width: 860px) {
      .hero { grid-template-columns: 1fr; }
      .hero-main, .hero-side, .app { padding: 22px; }
      h1 { max-width: none; }
      .results-head { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="panel hero-main">
        <span class="eyebrow">Port Node em validacao</span>
        <h1>Extrator de enderecos para PDFs GAN</h1>
        <p class="sub">Versao focada no parser e na exportacao. Sem login, sem planos e sem pagamento. A meta aqui e validar captura, revisar a qualidade da extracao e deixar a base pronta para publicar em hospedagem Node.</p>
      </div>
      <aside class="panel hero-side">
        <div class="meta-list">
          <div class="meta-item"><span>Entrada</span><strong>PDF ate 50 MB</strong></div>
          <div class="meta-item"><span>Saida</span><strong>Excel e TXT</strong></div>
          <div class="meta-item"><span>Modo</span><strong>Maximizar captura</strong></div>
          <div class="meta-item"><span>Health check</span><strong>/healthz</strong></div>
        </div>
        <p class="footnote">Se uma linha vier com bairro vazio ou texto deslocado, isso indica limite de leitura do PDF original. Ainda assim, a extracao fica disponivel para revisao e download.</p>
      </aside>
    </section>

    <section class="panel app">
      <label class="drop" id="drop">
        <div class="drop-icon">PDF</div>
        <strong>Arraste o arquivo aqui ou clique para escolher</strong>
        <small>Ideal para testar listas GAN reais e comparar com a versao Python.</small>
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
