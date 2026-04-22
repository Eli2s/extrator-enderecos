import io
import re
import os
import webbrowser
import threading
from collections import defaultdict

import pdfplumber
import openpyxl
from flask import Flask, render_template_string, request, send_file, jsonify

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # limite de 50 MB por upload


# ── detecção de colunas ───────────────────────────────────────────────────────

def _detectar_colunas(pagina) -> dict:
    """
    Detecta as posições X das colunas Endereço, Bairro e CEP no PDF.

    As listas de entrega GAN têm um layout posicional (não tabela real),
    então identificamos as colunas pelo header de texto e pelos dados.
    Os headers 'Bairro' e 'Cep' podem estar em linhas Y diferentes dependendo
    da versão do PDF, por isso buscamos cada um separadamente.
    """
    words = pagina.extract_words()

    # Agrupa palavras por linha (arredonda Y a 3pt para juntar palavras da mesma linha)
    linhas: dict[int, list] = defaultdict(list)
    for w in words:
        y = round(w["top"] / 3) * 3
        linhas[y].append(w)

    # Busca as posições X dos headers individualmente
    end_hdr = bairro_hdr = cep_hdr = None
    for y in sorted(linhas):
        ws = sorted(linhas[y], key=lambda w: w["x0"])
        for w in ws:
            t = w["text"].lower()
            if re.match(r"endere", t) and end_hdr is None:
                end_hdr = w["x0"]
            if t == "bairro" and bairro_hdr is None:
                bairro_hdr = w["x0"]
            if t == "cep" and cep_hdr is None:
                cep_hdr = w["x0"]

    # Se não encontrar os headers, usa posições padrão medidas nos PDFs GAN
    if bairro_hdr is None or cep_hdr is None:
        return {"endereco": 250, "bairro": 440, "cep": 530}

    # Encontra o X mínimo real de CEPs nos dados (8 dígitos próximos ao header Cep)
    cep_xs = []
    for y in sorted(linhas):
        ws = sorted(linhas[y], key=lambda w: w["x0"])
        for w in ws:
            digits = re.sub(r"\D", "", w["text"])
            if len(digits) == 8 and abs(w["x0"] - cep_hdr) < 60:
                cep_xs.append(w["x0"])

    # Borda esquerda de cada coluna (os headers ficam ~30-78pt à direita do início dos dados)
    x_cep    = min(cep_xs) - 5 if cep_xs else cep_hdr - 15
    x_bairro = bairro_hdr - 35
    x_end    = (end_hdr - 78) if end_hdr else x_bairro * 0.60

    return {"endereco": x_end, "bairro": x_bairro, "cep": x_cep}


# ── extração de endereços ─────────────────────────────────────────────────────

def extrair_enderecos(pdf_bytes: bytes) -> list[dict]:
    """
    Lê todas as páginas do PDF e extrai as colunas Endereço, Bairro e CEP.
    Ignora linhas sem CEP válido (8 dígitos) e linhas de cabeçalho.
    """
    enderecos = []

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for pagina in pdf.pages:
            cols = _detectar_colunas(pagina)

            words = pagina.extract_words()

            # Agrupa palavras por linha
            linhas: dict[int, list] = defaultdict(list)
            for w in words:
                y = round(w["top"] / 3) * 3
                linhas[y].append(w)

            for y in sorted(linhas):
                ws = sorted(linhas[y], key=lambda w: w["x0"])

                # Separa as palavras de cada coluna pela posição X
                end_words    = [w["text"] for w in ws if cols["endereco"] <= w["x0"] < cols["bairro"]]
                bairro_words = [w["text"] for w in ws if cols["bairro"]   <= w["x0"] < cols["cep"]]
                cep_words    = [w["text"] for w in ws if w["x0"]          >= cols["cep"]]

                # Só processa linhas com CEP válido de 8 dígitos
                cep_str = "".join(re.sub(r"\D", "", t) for t in cep_words)
                if len(cep_str) != 8 or not cep_str.isdigit():
                    continue
                if not end_words:
                    continue

                endereco = " ".join(end_words).strip()
                bairro   = " ".join(bairro_words).strip()

                # Descarta a linha de cabeçalho da tabela
                if "endere" in endereco.lower() or "bairro" in bairro.lower():
                    continue

                enderecos.append({"endereco": endereco, "cep": cep_str, "bairro": bairro})

    return enderecos


# ── geração de arquivos ───────────────────────────────────────────────────────

def gerar_xlsx(enderecos: list[dict]) -> bytes:
    """Gera um arquivo Excel (.xlsx) com os endereços extraídos."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Endereços"
    ws.append(["ENDEREÇO", "CEP", "BAIRRO"])
    for e in enderecos:
        ws.append([e["endereco"], e["cep"], e["bairro"]])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def gerar_txt(enderecos: list[dict]) -> bytes:
    """Gera um arquivo de texto com uma linha por endereço: ENDEREÇO, CEP, BAIRRO."""
    linhas = [f"{e['endereco']}, {e['cep']}, {e['bairro']}" for e in enderecos]
    return "\n".join(linhas).encode("utf-8")


# ── interface web ─────────────────────────────────────────────────────────────

HTML = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extrator de Endereços</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: 'Segoe UI', sans-serif; background: #0f0f13; color: #e0e0e0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 40px 16px }
  h1 { font-size: 1.6rem; font-weight: 600; color: #fff; margin-bottom: 6px }
  p.sub { color: #888; font-size: .9rem; margin-bottom: 32px }

  .drop-zone {
    width: 100%; max-width: 560px;
    border: 2px dashed #333;
    border-radius: 14px;
    padding: 48px 24px;
    text-align: center;
    cursor: pointer;
    transition: border-color .2s, background .2s;
    background: #16161c;
  }
  .drop-zone.hover { border-color: #4f8ef7; background: #1a1f2e }
  .drop-zone svg { width: 48px; height: 48px; stroke: #555; margin-bottom: 14px }
  .drop-zone .label { color: #aaa; font-size: .95rem }
  .drop-zone .label span { color: #4f8ef7; cursor: pointer }
  .drop-zone .filename { margin-top: 10px; font-size: .85rem; color: #4f8ef7; word-break: break-all }
  #file-input { display: none }

  .btn {
    margin-top: 24px;
    width: 100%; max-width: 560px;
    padding: 14px;
    border: none; border-radius: 10px;
    background: #4f8ef7; color: #fff;
    font-size: 1rem; font-weight: 600;
    cursor: pointer; transition: background .2s;
  }
  .btn:hover:not(:disabled) { background: #3a7be0 }
  .btn:disabled { background: #2a2a36; color: #555; cursor: not-allowed }

  #status { margin-top: 18px; font-size: .9rem; color: #aaa; min-height: 22px }
  #status.err { color: #f76f6f }
  #status.ok  { color: #5fcf80 }

  .results-wrap { width: 100%; max-width: 900px; margin-top: 36px }
  .results-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px;
  }
  .results-header h2 { font-size: 1rem; color: #ccc }
  .dl-btns { display: flex; gap: 8px }
  .dl-btn {
    padding: 7px 16px; border-radius: 8px; border: none;
    font-size: .82rem; font-weight: 600; cursor: pointer; transition: background .2s;
  }
  .dl-btn.xlsx { background: #1e7e34; color: #fff }
  .dl-btn.xlsx:hover { background: #17692b }
  .dl-btn.txt  { background: #2a4d8f; color: #fff }
  .dl-btn.txt:hover  { background: #1e3a6e }

  table { width: 100%; border-collapse: collapse; font-size: .85rem }
  thead th { background: #1e1e28; color: #aaa; padding: 10px 12px; text-align: left; font-weight: 500; border-bottom: 1px solid #2a2a36 }
  tbody tr { border-bottom: 1px solid #1e1e26 }
  tbody tr:hover { background: #1a1a24 }
  tbody td { padding: 9px 12px; color: #ddd }
  tbody td:nth-child(1) { color: #888; font-size: .8rem }
  tbody td:nth-child(3) { color: #888; font-family: monospace }

  .tag { display: inline-block; background: #1f2d1f; color: #5fcf80; border-radius: 6px; padding: 2px 8px; font-size: .78rem }
</style>
</head>
<body>

<h1>Extrator de Endereços</h1>
<p class="sub">Envia a lista de entregas em PDF e baixa os endereços prontos.</p>

<div class="drop-zone" id="drop-zone">
  <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 16V8m0 0-3 3m3-3 3 3"/>
    <path d="M20 16.5A4.5 4.5 0 0 0 15.5 12H15a7 7 0 1 0-6.91 8H16a4 4 0 0 0 4-3.5z"/>
  </svg>
  <p class="label">Arrasta o PDF aqui ou <span onclick="document.getElementById('file-input').click()">clica pra escolher</span></p>
  <p class="filename" id="fname"></p>
  <input type="file" id="file-input" accept=".pdf">
</div>

<button class="btn" id="btn-extrair" disabled>Extrair endereços</button>
<div id="status"></div>

<div class="results-wrap" id="results-wrap" style="display:none">
  <div class="results-header">
    <h2 id="results-count"></h2>
    <div class="dl-btns">
      <button class="dl-btn xlsx" id="btn-xlsx">⬇ Excel (.xlsx)</button>
      <button class="dl-btn txt"  id="btn-txt" >⬇ Texto (.txt)</button>
    </div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Endereço</th><th>CEP</th><th>Bairro</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<script>
  let arquivo = null;
  let ultimoResult = null;
  let ultimoNome = "";

  const dropZone   = document.getElementById("drop-zone");
  const fileInput  = document.getElementById("file-input");
  const fname      = document.getElementById("fname");
  const btnExtrair = document.getElementById("btn-extrair");
  const status     = document.getElementById("status");

  // Registra o arquivo selecionado e habilita o botão
  function setArquivo(f) {
    arquivo = f;
    ultimoNome = f.name.replace(/\\.pdf$/i, "");
    fname.textContent = f.name;
    btnExtrair.disabled = false;
    status.textContent = "";
    status.className = "";
    document.getElementById("results-wrap").style.display = "none";
  }

  fileInput.addEventListener("change", () => { if (fileInput.files[0]) setArquivo(fileInput.files[0]) });

  // Suporte a arrastar e soltar o PDF
  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("hover") });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("hover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault(); dropZone.classList.remove("hover");
    if (e.dataTransfer.files[0]?.name.toLowerCase().endsWith(".pdf")) setArquivo(e.dataTransfer.files[0]);
  });

  // Envia o PDF para o servidor e exibe os resultados
  btnExtrair.addEventListener("click", async () => {
    if (!arquivo) return;
    btnExtrair.disabled = true;
    status.className = "";
    status.textContent = "Processando...";

    const fd = new FormData();
    fd.append("pdf", arquivo);

    try {
      const res = await fetch("/extrair", { method: "POST", body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(data.erro);

      ultimoResult = data.enderecos;
      renderTabela(data.enderecos);
      status.className = "ok";
      status.textContent = `✓ ${data.enderecos.length} endereços extraídos.`;
    } catch(err) {
      status.className = "err";
      status.textContent = "Erro: " + err.message;
    } finally {
      btnExtrair.disabled = false;
    }
  });

  // Monta a tabela de resultados na tela
  function renderTabela(enderecos) {
    const tbody = document.getElementById("tbody");
    tbody.innerHTML = enderecos.map((e, i) =>
      `<tr>
        <td>${i + 1}</td>
        <td>${e.endereco}</td>
        <td>${e.cep}</td>
        <td><span class="tag">${e.bairro}</span></td>
      </tr>`
    ).join("");
    document.getElementById("results-count").textContent = `${enderecos.length} endereços encontrados`;
    document.getElementById("results-wrap").style.display = "";
  }

  // Solicita o download no formato escolhido (xlsx ou txt)
  async function baixar(fmt) {
    if (!ultimoResult) return;
    const res = await fetch("/baixar/" + fmt, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enderecos: ultimoResult, nome: ultimoNome })
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ultimoNome + (fmt === "xlsx" ? ".xlsx" : ".txt");
    a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById("btn-xlsx").addEventListener("click", () => baixar("xlsx"));
  document.getElementById("btn-txt" ).addEventListener("click", () => baixar("txt"));
</script>
</body>
</html>"""


# ── rotas Flask ───────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Página principal com a interface de upload."""
    return render_template_string(HTML)


@app.route("/extrair", methods=["POST"])
def extrair():
    """Recebe o PDF, extrai os endereços e retorna JSON."""
    if "pdf" not in request.files:
        return jsonify(ok=False, erro="Nenhum arquivo enviado.")
    arq = request.files["pdf"]
    if not arq.filename.lower().endswith(".pdf"):
        return jsonify(ok=False, erro="Arquivo precisa ser um PDF.")
    try:
        pdf_bytes = arq.read()
        enderecos = extrair_enderecos(pdf_bytes)
        if not enderecos:
            return jsonify(ok=False, erro="Nenhum endereço encontrado. O PDF precisa ter colunas Endereço, Bairro e CEP.")
        return jsonify(ok=True, enderecos=enderecos)
    except Exception as e:
        return jsonify(ok=False, erro=str(e))


@app.route("/baixar/<fmt>", methods=["POST"])
def baixar(fmt):
    """Gera e serve o arquivo de download (xlsx ou txt)."""
    data = request.get_json()
    enderecos = data.get("enderecos", [])
    nome = data.get("nome", "enderecos")

    if fmt == "xlsx":
        buf = gerar_xlsx(enderecos)
        return send_file(
            io.BytesIO(buf),
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=f"{nome}.xlsx",
        )
    else:
        buf = gerar_txt(enderecos)
        return send_file(
            io.BytesIO(buf),
            mimetype="text/plain; charset=utf-8",
            as_attachment=True,
            download_name=f"{nome}.txt",
        )


if __name__ == "__main__":
    porta = int(os.environ.get("PORT", 5001))
    # Abre o navegador automaticamente ao rodar localmente
    if porta == 5001:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{porta}")).start()
        print(f"Abrindo em http://localhost:{porta}")
    app.run(host="0.0.0.0", port=porta, debug=False)
