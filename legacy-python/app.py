import io
import re
import os
import sqlite3
import hmac
import hashlib
import webbrowser
import threading
import time
from datetime import datetime, timedelta
from collections import defaultdict
from functools import wraps

import pdfplumber
import openpyxl
from flask import (Flask, render_template_string, request, send_file,
                   jsonify, session, redirect, url_for, g)
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None
    dict_row = None

try:
    import mercadopago
    _MP_TOKEN = os.environ.get("MP_ACCESS_TOKEN", "")
    MP_SDK = mercadopago.SDK(_MP_TOKEN) if _MP_TOKEN else None
except ImportError:
    MP_SDK = None

MP_SIMULADO = MP_SDK is None

# ── config ────────────────────────────────────────────────────────────────────

RAW_DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
DATABASE_URL = RAW_DATABASE_URL.replace("postgres://", "postgresql://", 1) if RAW_DATABASE_URL.startswith("postgres://") else RAW_DATABASE_URL
DB_BACKEND = "postgres" if DATABASE_URL.startswith("postgresql://") else "sqlite"
DB_PATH = os.path.join(os.path.dirname(__file__), "saas.db")
CREDITOS_GRATIS = 5
MP_WEBHOOK_SECRET = os.environ.get("MP_WEBHOOK_SECRET", "").strip()

SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    if DB_BACKEND == "postgres" or os.environ.get("RENDER"):
        raise RuntimeError("SECRET_KEY não configurada.")
    SECRET_KEY = "eli2s-gan-extrator-dev-2025"

SESSION_COOKIE_SECURE = os.environ.get(
    "SESSION_COOKIE_SECURE",
    "1" if os.environ.get("RENDER") else "0"
) == "1"

app = Flask(__name__)
app.config.update(
    MAX_CONTENT_LENGTH=50 * 1024 * 1024,
    SECRET_KEY=SECRET_KEY,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=SESSION_COOKIE_SECURE,
)

if os.environ.get("RENDER"):
    @app.before_request
    def render_offline():
        return "Site temporariamente indisponivel.", 503

PLANOS = {
    "credito_1":  {"nome": "1 Extração",   "label": "Avulso",  "valor": 1.90,  "creditos": 1,  "dias": None, "destaque": False},
    "credito_5":  {"nome": "5 Extrações",  "label": "Pack",    "valor": 7.90,  "creditos": 5,  "dias": None, "destaque": False},
    "credito_15": {"nome": "15 Extrações", "label": "Pack",    "valor": 19.90, "creditos": 15, "dias": None, "destaque": False},
    "semanal":    {"nome": "Semanal",      "label": "Semanal", "valor": 9.90,  "creditos": None, "dias": 7,  "destaque": False},
    "mensal":     {"nome": "Mensal",       "label": "Mensal",  "valor": 29.90, "creditos": None, "dias": 30, "destaque": True},
}

# ── banco de dados ────────────────────────────────────────────────────────────

class Database:
    def __init__(self, conn, backend: str):
        self.conn = conn
        self.backend = backend

    def _query(self, query: str) -> str:
        if self.backend == "postgres":
            return query.replace("?", "%s")
        return query

    def execute(self, query: str, params=()):
        return self.conn.execute(self._query(query), params)

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()


def _connect_db() -> Database:
    if DB_BACKEND == "postgres":
        if psycopg is None:
            raise RuntimeError("psycopg não instalado para usar DATABASE_URL PostgreSQL.")
        return Database(psycopg.connect(DATABASE_URL, row_factory=dict_row), "postgres")

    conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    return Database(conn, "sqlite")


def get_db() -> Database:
    if "db" not in g:
        g.db = _connect_db()
    return g.db

@app.teardown_appcontext
def close_db(e=None):
    db = g.pop("db", None)
    if db:
        db.close()

def init_db():
    with app.app_context():
        db = get_db()
        if DB_BACKEND == "postgres":
            statements = [
                """
                CREATE TABLE IF NOT EXISTS usuarios (
                    id           BIGSERIAL PRIMARY KEY,
                    nome         TEXT NOT NULL,
                    email        TEXT UNIQUE NOT NULL,
                    senha_hash   TEXT NOT NULL,
                    plano        TEXT NOT NULL DEFAULT 'free',
                    plano_expira TEXT,
                    creditos     INTEGER NOT NULL DEFAULT 0,
                    criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS pagamentos (
                    id           BIGSERIAL PRIMARY KEY,
                    usuario_id   BIGINT NOT NULL REFERENCES usuarios(id),
                    plano_key    TEXT NOT NULL,
                    valor        NUMERIC(10, 2) NOT NULL,
                    mp_id        TEXT,
                    status       TEXT NOT NULL DEFAULT 'pendente',
                    criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS usos (
                    id           BIGSERIAL PRIMARY KEY,
                    usuario_id   BIGINT NOT NULL REFERENCES usuarios(id),
                    enderecos    INTEGER NOT NULL,
                    criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """,
                "CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email)",
                "CREATE INDEX IF NOT EXISTS idx_pagamentos_usuario_id ON pagamentos(usuario_id)",
                "CREATE INDEX IF NOT EXISTS idx_usos_usuario_id ON usos(usuario_id)",
            ]
        else:
            statements = [
                """
                CREATE TABLE IF NOT EXISTS usuarios (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    nome         TEXT    NOT NULL,
                    email        TEXT    UNIQUE NOT NULL,
                    senha_hash   TEXT    NOT NULL,
                    plano        TEXT    NOT NULL DEFAULT 'free',
                    plano_expira TEXT,
                    creditos     INTEGER NOT NULL DEFAULT 0,
                    criado_em    TEXT    NOT NULL DEFAULT (datetime('now'))
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS pagamentos (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    usuario_id   INTEGER NOT NULL,
                    plano_key    TEXT    NOT NULL,
                    valor        REAL    NOT NULL,
                    mp_id        TEXT,
                    status       TEXT    NOT NULL DEFAULT 'pendente',
                    criado_em    TEXT    NOT NULL DEFAULT (datetime('now'))
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS usos (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    usuario_id   INTEGER NOT NULL,
                    enderecos    INTEGER NOT NULL,
                    criado_em    TEXT    NOT NULL DEFAULT (datetime('now'))
                )
                """,
                "CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email)",
                "CREATE INDEX IF NOT EXISTS idx_pagamentos_usuario_id ON pagamentos(usuario_id)",
                "CREATE INDEX IF NOT EXISTS idx_usos_usuario_id ON usos(usuario_id)",
            ]
        for statement in statements:
            db.execute(statement)
        db.commit()


def registrar_pagamento_pendente(usuario_id: int, plano_key: str, valor: float) -> int:
    db = get_db()
    if DB_BACKEND == "postgres":
        cursor = db.execute(
            "INSERT INTO pagamentos (usuario_id, plano_key, valor, status) VALUES (?,?,?,?) RETURNING id",
            (usuario_id, plano_key, valor, "pendente")
        )
        pagamento_id = cursor.fetchone()["id"]
    else:
        cursor = db.execute(
            "INSERT INTO pagamentos (usuario_id, plano_key, valor, status) VALUES (?,?,?,?)",
            (usuario_id, plano_key, valor, "pendente")
        )
        pagamento_id = cursor.lastrowid
    db.commit()
    return int(pagamento_id)


def rollback_silencioso():
    db = g.get("db")
    if db:
        try:
            db.rollback()
        except Exception:
            pass


def is_unique_violation(exc: Exception) -> bool:
    if isinstance(exc, sqlite3.IntegrityError):
        return True
    sqlstate = getattr(exc, "sqlstate", None) or getattr(exc, "pgcode", None)
    return sqlstate == "23505"

# ── helpers de plano ──────────────────────────────────────────────────────────

def usuario_logado():
    uid = session.get("uid")
    if not uid:
        return None
    return get_db().execute("SELECT * FROM usuarios WHERE id=?", (uid,)).fetchone()

def plano_ativo(u) -> bool:
    if u["plano_expira"]:
        try:
            expira = datetime.fromisoformat(u["plano_expira"])
            if expira > datetime.now():
                return True
        except ValueError:
            pass
    return False

def pode_extrair(u) -> tuple[bool, str]:
    if plano_ativo(u):
        return True, "assinatura"
    if u["creditos"] > 0:
        return True, "credito"
    return False, ""

def label_plano(u) -> str:
    if plano_ativo(u):
        exp = datetime.fromisoformat(u["plano_expira"])
        dias = (exp - datetime.now()).days
        return f"{u['plano'].capitalize()} · vence em {dias + 1}d"
    if u["creditos"] > 0:
        return f"{u['creditos']} crédito{'s' if u['creditos'] != 1 else ''}"
    return "Sem acesso"

def aplicar_pagamento(usuario_id: int, plano_key: str):
    db = get_db()
    p = PLANOS[plano_key]
    if p["dias"]:
        agora = datetime.now()
        u = db.execute("SELECT plano_expira FROM usuarios WHERE id=?", (usuario_id,)).fetchone()
        if u and u["plano_expira"]:
            try:
                base = datetime.fromisoformat(u["plano_expira"])
                base = max(base, agora)
            except ValueError:
                base = agora
        else:
            base = agora
        nova_expira = (base + timedelta(days=p["dias"])).isoformat()
        db.execute(
            "UPDATE usuarios SET plano=?, plano_expira=? WHERE id=?",
            (plano_key, nova_expira, usuario_id)
        )
    else:
        db.execute(
            "UPDATE usuarios SET creditos = creditos + ? WHERE id=?",
            (p["creditos"], usuario_id)
        )
    db.commit()


def confirmar_pagamento(pagamento_id: int, mp_payment_id: str | None = None, status: str = "aprovado") -> bool:
    db = get_db()
    pg = db.execute("SELECT * FROM pagamentos WHERE id=?", (pagamento_id,)).fetchone()
    if not pg:
        return False

    if pg["status"] == "aprovado":
        if mp_payment_id and pg["mp_id"] != mp_payment_id:
            db.execute("UPDATE pagamentos SET mp_id=? WHERE id=?", (mp_payment_id, pagamento_id))
            db.commit()
        return False

    db.execute("UPDATE pagamentos SET status=?, mp_id=? WHERE id=?",
               (status, mp_payment_id or pg["mp_id"], pagamento_id))
    db.commit()

    if status == "aprovado":
        aplicar_pagamento(pg["usuario_id"], pg["plano_key"])
        return True
    return False


def validar_webhook_mp(req) -> bool:
    if not MP_WEBHOOK_SECRET:
        return True

    x_signature = req.headers.get("x-signature", "")
    x_request_id = req.headers.get("x-request-id", "")
    data_id = req.args.get("data.id", "")
    if not x_signature or not x_request_id or not data_id:
        return False

    partes = {}
    for part in x_signature.split(","):
        key, sep, value = part.strip().partition("=")
        if sep:
            partes[key] = value

    ts = partes.get("ts")
    received_hash = partes.get("v1")
    if not ts or not received_hash:
        return False

    try:
        ts_int = int(ts)
    except ValueError:
        return False

    agora_ms = int(time.time() * 1000)
    if abs(agora_ms - ts_int) > 5 * 60 * 1000:
        return False

    manifest = f"id:{data_id};request-id:{x_request_id};ts:{ts};"
    expected_hash = hmac.new(
        MP_WEBHOOK_SECRET.encode(),
        manifest.encode(),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected_hash, received_hash)

# ── decoradores ───────────────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("uid"):
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

# ── extração de PDF ───────────────────────────────────────────────────────────

def _detectar_colunas(pagina) -> dict:
    words = pagina.extract_words()
    linhas: dict[int, list] = defaultdict(list)
    for w in words:
        y = round(w["top"] / 3) * 3
        linhas[y].append(w)

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

    if bairro_hdr is None or cep_hdr is None:
        return {"endereco": 250, "bairro": 440, "cep": 530}

    cep_xs = []
    for y in sorted(linhas):
        ws = sorted(linhas[y], key=lambda w: w["x0"])
        for w in ws:
            digits = re.sub(r"\D", "", w["text"])
            if len(digits) == 8 and abs(w["x0"] - cep_hdr) < 60:
                cep_xs.append(w["x0"])

    x_cep    = min(cep_xs) - 5 if cep_xs else cep_hdr - 15
    x_bairro = bairro_hdr - 35
    x_end    = (end_hdr - 78) if end_hdr else x_bairro * 0.60
    return {"endereco": x_end, "bairro": x_bairro, "cep": x_cep}


def extrair_enderecos(pdf_bytes: bytes) -> list[dict]:
    enderecos = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for pagina in pdf.pages:
            cols = _detectar_colunas(pagina)
            words = pagina.extract_words()
            linhas: dict[int, list] = defaultdict(list)
            for w in words:
                y = round(w["top"] / 3) * 3
                linhas[y].append(w)

            for y in sorted(linhas):
                ws = sorted(linhas[y], key=lambda w: w["x0"])
                end_words    = [w["text"] for w in ws if cols["endereco"] <= w["x0"] < cols["bairro"]]
                bairro_words = [w["text"] for w in ws if cols["bairro"]   <= w["x0"] < cols["cep"]]
                cep_words    = [w["text"] for w in ws if w["x0"]          >= cols["cep"]]
                cep_str = "".join(re.sub(r"\D", "", t) for t in cep_words)
                if len(cep_str) != 8 or not cep_str.isdigit():
                    continue
                if not end_words:
                    continue
                endereco = " ".join(end_words).strip()
                bairro   = " ".join(bairro_words).strip()
                if "endere" in endereco.lower() or "bairro" in bairro.lower():
                    continue
                enderecos.append({"endereco": endereco, "cep": cep_str, "bairro": bairro})
    return enderecos


def gerar_xlsx(enderecos: list[dict]) -> bytes:
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
    return "\n".join(f"{e['endereco']}, {e['cep']}, {e['bairro']}" for e in enderecos).encode("utf-8")

# ── templates HTML ────────────────────────────────────────────────────────────

_BASE_STYLE = """
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
body { font-family: 'Segoe UI', sans-serif; background: #0f0f13; color: #e0e0e0; min-height: 100vh }
a { color: inherit; text-decoration: none }
.btn {
  display: inline-block; padding: 12px 24px; border: none; border-radius: 10px;
  background: #4f8ef7; color: #fff; font-size: .95rem; font-weight: 600;
  cursor: pointer; transition: background .2s; text-align: center;
}
.btn:hover { background: #3a7be0 }
.btn.outline { background: transparent; border: 1px solid #333; color: #aaa }
.btn.outline:hover { border-color: #4f8ef7; color: #4f8ef7 }
.btn.sm { padding: 7px 16px; font-size: .82rem }
.btn.verde { background: #1e7e34 }
.btn.verde:hover { background: #17692b }
input[type=text], input[type=email], input[type=password] {
  width: 100%; padding: 11px 14px; border-radius: 8px;
  border: 1px solid #2a2a3a; background: #1e1e28; color: #e0e0e0;
  font-size: .95rem; outline: none; transition: border-color .2s;
}
input:focus { border-color: #4f8ef7 }
label { display: block; font-size: .8rem; color: #888; margin-bottom: 6px; margin-top: 16px }
.erro { margin-top: 12px; font-size: .85rem; color: #f76f6f; text-align: center }
</style>
"""

HTML_AUTH = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ titulo }} · Extrator GAN</title>
""" + _BASE_STYLE + """
<style>
body { display: flex; align-items: center; justify-content: center }
.card { background: #16161c; border: 1px solid #1e1e2a; border-radius: 16px; padding: 44px 40px; width: 100%; max-width: 380px }
.logo { text-align: center; margin-bottom: 28px }
.logo svg { width: 44px; height: 44px; stroke: #4f8ef7; margin-bottom: 10px }
.logo h1 { font-size: 1.2rem; color: #fff; font-weight: 600 }
.logo p { font-size: .78rem; color: #444; margin-top: 4px }
.btn { width: 100%; margin-top: 22px; padding: 13px }
.troca { margin-top: 20px; text-align: center; font-size: .82rem; color: #555 }
.troca a { color: #4f8ef7 }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 16V8m0 0-3 3m3-3 3 3"/>
      <path d="M20 16.5A4.5 4.5 0 0 0 15.5 12H15a7 7 0 1 0-6.91 8H16a4 4 0 0 0 4-3.5z"/>
    </svg>
    <h1>Extrator de Endereços</h1>
    <p>Desenvolvido por Elias Samuel · eli2s</p>
  </div>
  <form method="POST">
    {% if modo == 'cadastro' %}
    <label>Nome</label>
    <input type="text" name="nome" placeholder="Seu nome" value="{{ form.nome }}" autofocus>
    {% endif %}
    <label>E-mail</label>
    <input type="email" name="email" placeholder="voce@email.com" value="{{ form.email }}" {% if modo == 'login' %}autofocus{% endif %}>
    <label>Senha</label>
    <input type="password" name="senha" placeholder="••••••••">
    {% if erro %}<p class="erro">{{ erro }}</p>{% endif %}
    <button class="btn" type="submit">{{ titulo }}</button>
  </form>
  {% if modo == 'login' %}
  <p class="troca">Não tem conta? <a href="/cadastro">Cadastre-se grátis</a></p>
  {% else %}
  <p class="troca">Já tem conta? <a href="/login">Entrar</a></p>
  {% endif %}
</div>
</body></html>"""


HTML_PLANOS = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Planos · Extrator GAN</title>
""" + _BASE_STYLE + """
<style>
nav { display: flex; justify-content: space-between; align-items: center;
      padding: 18px 40px; border-bottom: 1px solid #1a1a22; max-width: 1100px; margin: 0 auto; width: 100% }
nav .logo-nav { font-size: 1rem; font-weight: 600; color: #fff }
nav .logo-nav span { color: #4f8ef7 }
.hero { text-align: center; padding: 72px 20px 48px }
.hero h1 { font-size: 2.2rem; font-weight: 700; color: #fff; line-height: 1.2 }
.hero h1 span { color: #4f8ef7 }
.hero p { color: #888; margin-top: 14px; font-size: 1.05rem }
.hero .free-tag { display: inline-block; margin-top: 18px; background: #1a2a1a; color: #5fcf80;
                  border: 1px solid #2a4a2a; border-radius: 20px; padding: 6px 18px; font-size: .85rem }
.cards { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; padding: 0 20px 60px; max-width: 1100px; margin: 0 auto }
.card {
  background: #16161c; border: 1px solid #222230; border-radius: 16px;
  padding: 32px 28px; width: 100%; max-width: 280px; position: relative;
}
.card.destaque { border-color: #4f8ef7; box-shadow: 0 0 0 1px #4f8ef720 }
.badge-destaque { position: absolute; top: -12px; left: 50%; transform: translateX(-50%);
                  background: #4f8ef7; color: #fff; border-radius: 20px; padding: 4px 16px;
                  font-size: .75rem; font-weight: 700; white-space: nowrap }
.card h2 { font-size: 1.1rem; color: #ccc; font-weight: 600 }
.card .preco { margin: 16px 0 4px }
.card .preco strong { font-size: 2rem; color: #fff }
.card .preco small { font-size: .85rem; color: #666 }
.card .desc { font-size: .82rem; color: #555; margin-bottom: 20px; min-height: 36px }
.card ul { list-style: none; margin-bottom: 24px }
.card ul li { font-size: .85rem; color: #888; padding: 4px 0 }
.card ul li::before { content: "✓ "; color: #4f8ef7 }
.card .btn { width: 100% }
.divider { width: 100%; max-width: 860px; margin: 0 auto 48px; border: none; border-top: 1px solid #1a1a22 }
.creditos-section { text-align: center; padding: 0 20px 60px }
.creditos-section h2 { font-size: 1.3rem; color: #ccc; margin-bottom: 8px }
.creditos-section p { color: #666; font-size: .9rem; margin-bottom: 28px }
.creditos-grid { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap }
.credito-card { background: #16161c; border: 1px solid #222230; border-radius: 12px;
                padding: 20px 24px; min-width: 160px; text-align: center }
.credito-card h3 { font-size: .9rem; color: #aaa }
.credito-card .val { font-size: 1.5rem; font-weight: 700; color: #fff; margin: 6px 0 2px }
.credito-card .por-un { font-size: .75rem; color: #555; margin-bottom: 14px }
.credito-card .btn { width: 100% }
footer { text-align: center; padding: 32px; color: #333; font-size: .8rem; border-top: 1px solid #1a1a22 }
</style>
</head>
<body>

<nav>
  <span class="logo-nav">Extrator <span>GAN</span></span>
  <div style="display:flex;gap:10px">
    {% if logado %}
    <a href="/" class="btn sm">Ir para o app</a>
    {% else %}
    <a href="/login" class="btn outline sm">Entrar</a>
    <a href="/cadastro" class="btn sm">Cadastrar grátis</a>
    {% endif %}
  </div>
</nav>

<div class="hero">
  <h1>Extraia endereços de PDFs<br><span>em segundos</span></h1>
  <p>Para listas de entrega GAN. Exporte em Excel ou TXT prontos pra usar.</p>
  <span class="free-tag">🎁 5 extrações grátis ao se cadastrar · sem cartão</span>
</div>

<div class="cards">

  <div class="card">
    <h2>Semanal</h2>
    <div class="preco"><strong>R$9,90</strong><small>/semana</small></div>
    <p class="desc">Ideal para uso frequente durante a semana</p>
    <ul>
      <li>Extrações ilimitadas</li>
      <li>Download em Excel e TXT</li>
      <li>Renova automaticamente</li>
    </ul>
    <a href="/assinar/semanal" class="btn outline">Assinar semanal</a>
  </div>

  <div class="card destaque">
    <span class="badge-destaque">⭐ Mais popular</span>
    <h2>Mensal</h2>
    <div class="preco"><strong>R$29,90</strong><small>/mês</small></div>
    <p class="desc">Economize 25% comparado ao plano semanal</p>
    <ul>
      <li>Extrações ilimitadas</li>
      <li>Download em Excel e TXT</li>
      <li>Acesso por 30 dias</li>
    </ul>
    <a href="/assinar/mensal" class="btn">Assinar mensal</a>
  </div>

</div>

<hr class="divider">

<div class="creditos-section">
  <h2>Prefere pagar por uso?</h2>
  <p>Compre créditos e use quando precisar. Sem recorrência.</p>
  <div class="creditos-grid">
    <div class="credito-card">
      <h3>1 extração</h3>
      <div class="val">R$1,90</div>
      <div class="por-un">R$1,90 por extração</div>
      <a href="/assinar/credito_1" class="btn sm outline">Comprar</a>
    </div>
    <div class="credito-card">
      <h3>5 extrações</h3>
      <div class="val">R$7,90</div>
      <div class="por-un">R$1,58/un — economize 17%</div>
      <a href="/assinar/credito_5" class="btn sm outline">Comprar</a>
    </div>
    <div class="credito-card">
      <h3>15 extrações</h3>
      <div class="val">R$19,90</div>
      <div class="por-un">R$1,33/un — economize 30%</div>
      <a href="/assinar/credito_15" class="btn sm">Comprar</a>
    </div>
  </div>
</div>

<footer>Extrator GAN · desenvolvido por Elias Samuel · <a href="https://github.com/Eli2s" style="color:#333">github.com/Eli2s</a></footer>

</body></html>"""


HTML_APP = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extrator GAN</title>
""" + _BASE_STYLE + """
<style>
body { display: flex; flex-direction: column; align-items: center; min-height: 100vh }
.topbar {
  width: 100%; background: #13131a; border-bottom: 1px solid #1e1e2a;
  padding: 10px 24px; display: flex; justify-content: space-between; align-items: center;
}
.topbar .logo { font-size: .9rem; font-weight: 600; color: #fff }
.topbar .logo span { color: #4f8ef7 }
.topbar-right { display: flex; align-items: center; gap: 14px }
.plan-badge {
  font-size: .78rem; padding: 4px 12px; border-radius: 20px;
  background: #1a2a1a; color: #5fcf80; border: 1px solid #2a4a2a;
}
.plan-badge.sem-acesso { background: #2a1a1a; color: #f76f6f; border-color: #4a2a2a }
.plan-badge.trial { background: #1a1f2e; color: #4f8ef7; border-color: #2a3050 }
.topbar-right a.sair { font-size: .78rem; color: #444; padding: 4px 10px;
                       border: 1px solid #222; border-radius: 6px }
.topbar-right a.sair:hover { color: #f76f6f; border-color: #f76f6f }
.main { width: 100%; max-width: 600px; padding: 40px 16px; display: flex; flex-direction: column; align-items: center }
h1 { font-size: 1.5rem; font-weight: 600; color: #fff; margin-bottom: 6px }
p.sub { color: #666; font-size: .88rem; margin-bottom: 28px }
.drop-zone {
  width: 100%; border: 2px dashed #2a2a3a; border-radius: 14px;
  padding: 48px 24px; text-align: center; cursor: pointer;
  transition: border-color .2s, background .2s; background: #16161c;
}
.drop-zone.hover { border-color: #4f8ef7; background: #1a1f2e }
.drop-zone svg { width: 44px; height: 44px; stroke: #555; margin-bottom: 12px }
.drop-zone .label { color: #888; font-size: .92rem }
.drop-zone .label span { color: #4f8ef7; cursor: pointer }
.drop-zone .fname { margin-top: 8px; font-size: .82rem; color: #4f8ef7; word-break: break-all }
#file-input { display: none }
.btn-extrair {
  margin-top: 20px; width: 100%; padding: 14px; border: none; border-radius: 10px;
  background: #4f8ef7; color: #fff; font-size: 1rem; font-weight: 600;
  cursor: pointer; transition: background .2s;
}
.btn-extrair:hover:not(:disabled) { background: #3a7be0 }
.btn-extrair:disabled { background: #2a2a36; color: #444; cursor: not-allowed }
#status { margin-top: 14px; font-size: .88rem; color: #666; min-height: 20px }
#status.err { color: #f76f6f }
#status.ok  { color: #5fcf80 }
.results-wrap { width: 100%; max-width: 940px; margin-top: 32px; padding: 0 16px }
.results-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px }
.results-header h2 { font-size: .95rem; color: #aaa }
.dl-btns { display: flex; gap: 8px }
.dl-btn { padding: 7px 16px; border-radius: 8px; border: none; font-size: .8rem; font-weight: 600; cursor: pointer; transition: background .2s }
.dl-btn.xlsx { background: #1e7e34; color: #fff }
.dl-btn.xlsx:hover { background: #17692b }
.dl-btn.txt  { background: #2a4d8f; color: #fff }
.dl-btn.txt:hover  { background: #1e3a6e }
table { width: 100%; border-collapse: collapse; font-size: .84rem }
thead th { background: #1e1e28; color: #888; padding: 10px 12px; text-align: left; font-weight: 500; border-bottom: 1px solid #2a2a36 }
tbody tr { border-bottom: 1px solid #1e1e26 }
tbody tr:hover { background: #1a1a24 }
tbody td { padding: 9px 12px; color: #ddd }
tbody td:nth-child(1) { color: #555; font-size: .78rem }
tbody td:nth-child(3) { color: #888; font-family: monospace }
.tag { display: inline-block; background: #1f2d1f; color: #5fcf80; border-radius: 6px; padding: 2px 8px; font-size: .76rem }
/* overlay sem acesso */
.overlay-bloqueio {
  position: fixed; inset: 0; background: rgba(0,0,0,.75); display: flex;
  align-items: center; justify-content: center; z-index: 100;
  backdrop-filter: blur(4px);
}
.overlay-card {
  background: #16161c; border: 1px solid #2a2a3a; border-radius: 16px;
  padding: 40px; max-width: 400px; text-align: center;
}
.overlay-card h2 { font-size: 1.2rem; color: #fff; margin-bottom: 10px }
.overlay-card p { color: #666; font-size: .88rem; margin-bottom: 24px }
.overlay-card .btn { display: block; margin-top: 10px }
</style>
</head>
<body>

<div class="topbar">
  <span class="logo">Extrator <span>GAN</span></span>
  <div class="topbar-right">
    {% if assinatura_ativa %}
      <span class="plan-badge">{{ label_plano }}</span>
    {% elif creditos > 0 %}
      <span class="plan-badge trial">{{ label_plano }}</span>
    {% else %}
      <span class="plan-badge sem-acesso">Sem acesso</span>
    {% endif %}
    <a href="/planos" class="btn sm outline" style="font-size:.78rem">Planos</a>
    <a href="/logout" class="sair">Sair</a>
  </div>
</div>

{% if bloqueado %}
<div class="overlay-bloqueio">
  <div class="overlay-card">
    <h2>Seus créditos acabaram</h2>
    <p>Escolha um plano para continuar extraindo endereços.</p>
    <a href="/planos" class="btn">Ver planos</a>
    <a href="/logout" class="btn outline" style="margin-top:8px">Sair</a>
  </div>
</div>
{% endif %}

<div class="main">
  <h1>Extrator de Endereços</h1>
  <p class="sub">Arraste a lista de entregas GAN em PDF e exporte os endereços.</p>

  <div class="drop-zone" id="drop-zone">
    <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 16V8m0 0-3 3m3-3 3 3"/>
      <path d="M20 16.5A4.5 4.5 0 0 0 15.5 12H15a7 7 0 1 0-6.91 8H16a4 4 0 0 0 4-3.5z"/>
    </svg>
    <p class="label">Arraste o PDF aqui ou <span onclick="document.getElementById('file-input').click()">clique para escolher</span></p>
    <p class="fname" id="fname"></p>
    <input type="file" id="file-input" accept=".pdf">
  </div>

  <button class="btn-extrair" id="btn-extrair" disabled>Extrair endereços</button>
  <div id="status"></div>
</div>

<div class="results-wrap" id="results-wrap" style="display:none">
  <div class="results-header">
    <h2 id="results-count"></h2>
    <div class="dl-btns">
      <button class="dl-btn xlsx" id="btn-xlsx">⬇ Excel (.xlsx)</button>
      <button class="dl-btn txt"  id="btn-txt">⬇ Texto (.txt)</button>
    </div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Endereço</th><th>CEP</th><th>Bairro</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<script>
let arquivo = null, ultimoResult = null, ultimoNome = "";
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fname     = document.getElementById("fname");
const btnEx     = document.getElementById("btn-extrair");
const status    = document.getElementById("status");

function setArquivo(f) {
  arquivo = f; ultimoNome = f.name.replace(/\\.pdf$/i, "");
  fname.textContent = f.name; btnEx.disabled = false;
  status.textContent = ""; status.className = "";
  document.getElementById("results-wrap").style.display = "none";
}
fileInput.addEventListener("change", () => { if (fileInput.files[0]) setArquivo(fileInput.files[0]) });
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("hover") });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("hover"));
dropZone.addEventListener("drop", e => {
  e.preventDefault(); dropZone.classList.remove("hover");
  if (e.dataTransfer.files[0]?.name.toLowerCase().endsWith(".pdf")) setArquivo(e.dataTransfer.files[0]);
});
btnEx.addEventListener("click", async () => {
  if (!arquivo) return;
  btnEx.disabled = true; status.className = ""; status.textContent = "Processando...";
  const fd = new FormData(); fd.append("pdf", arquivo);
  try {
    const res = await fetch("/extrair", { method: "POST", body: fd });
    const data = await res.json();
    if (!data.ok) throw new Error(data.erro);
    ultimoResult = data.enderecos; renderTabela(data.enderecos);
    status.className = "ok"; status.textContent = "✓ " + data.enderecos.length + " endereços extraídos.";
    if (data.creditos_restantes !== undefined) {
      const badge = document.querySelector(".plan-badge");
      if (badge) badge.textContent = data.creditos_restantes + " crédito" + (data.creditos_restantes !== 1 ? "s" : "");
    }
  } catch(err) {
    status.className = "err"; status.textContent = "Erro: " + err.message;
    if (err.message.includes("crédito") || err.message.includes("plano")) {
      setTimeout(() => window.location.reload(), 1500);
    }
  } finally { btnEx.disabled = false }
});
function renderTabela(enderecos) {
  document.getElementById("tbody").innerHTML = enderecos.map((e, i) =>
    `<tr><td>${i+1}</td><td>${e.endereco}</td><td>${e.cep}</td><td><span class="tag">${e.bairro}</span></td></tr>`
  ).join("");
  document.getElementById("results-count").textContent = enderecos.length + " endereços encontrados";
  document.getElementById("results-wrap").style.display = "";
}
async function baixar(fmt) {
  if (!ultimoResult) return;
  const res = await fetch("/baixar/" + fmt, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enderecos: ultimoResult, nome: ultimoNome })
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url;
  a.download = ultimoNome + (fmt === "xlsx" ? ".xlsx" : ".txt"); a.click();
  URL.revokeObjectURL(url);
}
document.getElementById("btn-xlsx").addEventListener("click", () => baixar("xlsx"));
document.getElementById("btn-txt").addEventListener("click",  () => baixar("txt"));
</script>
</body></html>"""


HTML_COMPRAR = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comprar · Extrator GAN</title>
""" + _BASE_STYLE + """
<style>
body { display: flex; align-items: center; justify-content: center; min-height: 100vh }
.card { background: #16161c; border: 1px solid #1e1e2a; border-radius: 16px; padding: 44px 40px; max-width: 420px; width: 100%; text-align: center }
.card h1 { font-size: 1.2rem; color: #fff; margin-bottom: 6px }
.card .plano-nome { font-size: 2rem; font-weight: 700; color: #fff; margin: 20px 0 4px }
.card .valor { font-size: 1.1rem; color: #4f8ef7; margin-bottom: 24px }
.card .aviso { font-size: .8rem; color: #555; margin-bottom: 24px }
.card .simulado { background: #1a2a1a; border: 1px solid #2a4a2a; border-radius: 10px;
                  padding: 12px; margin-bottom: 20px; font-size: .82rem; color: #5fcf80 }
.btn { display: block; width: 100%; padding: 14px; margin-top: 10px }
</style>
</head>
<body>
<div class="card">
  <h1>Confirmar compra</h1>
  <div class="plano-nome">{{ plano.nome }}</div>
  <div class="valor">R$ {{ "%.2f"|format(plano.valor) }}</div>
  {% if simulado %}
  <div class="simulado">⚠ Modo simulado — pagamento aprovado automaticamente<br>(configure MP_ACCESS_TOKEN para produção)</div>
  {% endif %}
  <p class="aviso">Ao confirmar, você será {% if simulado %}direcionado de volta ao app com acesso liberado{% else %}redirecionado ao Mercado Pago{% endif %}.</p>
  <form method="POST">
    <button class="btn" type="submit">{% if simulado %}Confirmar (simulado){% else %}Pagar com Mercado Pago{% endif %}</button>
  </form>
  <a href="/planos" class="btn outline" style="margin-top:8px">Voltar</a>
</div>
</body></html>"""


HTML_STATUS_PGTO = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ titulo }} · Extrator GAN</title>
""" + _BASE_STYLE + """
<style>
body { display: flex; align-items: center; justify-content: center; min-height: 100vh }
.card { background: #16161c; border: 1px solid #1e1e2a; border-radius: 16px; padding: 48px 40px; max-width: 380px; width: 100%; text-align: center }
.icon { font-size: 3rem; margin-bottom: 16px }
.card h1 { font-size: 1.2rem; color: #fff; margin-bottom: 10px }
.card p { color: #666; font-size: .9rem; margin-bottom: 28px }
.btn { display: block; width: 100%; padding: 13px; margin-top: 10px }
</style>
</head>
<body>
<div class="card">
  <div class="icon">{{ icone }}</div>
  <h1>{{ titulo }}</h1>
  <p>{{ msg }}</p>
  <a href="/" class="btn">Ir para o app</a>
  <a href="/planos" class="btn outline">Ver planos</a>
</div>
</body></html>"""

# ── rotas de autenticação ─────────────────────────────────────────────────────

@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("uid"):
        return redirect(url_for("index"))
    erro = None
    form = {"email": ""}
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        senha = request.form.get("senha", "")
        form["email"] = email
        u = get_db().execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()
        if u and check_password_hash(u["senha_hash"], senha):
            session["uid"] = u["id"]
            return redirect(url_for("index"))
        erro = "E-mail ou senha incorretos."
    return render_template_string(HTML_AUTH, modo="login", titulo="Entrar", erro=erro, form=form)


@app.route("/cadastro", methods=["GET", "POST"])
def cadastro():
    if session.get("uid"):
        return redirect(url_for("index"))
    erro = None
    form = {"nome": "", "email": ""}
    if request.method == "POST":
        nome  = request.form.get("nome", "").strip()
        email = request.form.get("email", "").strip().lower()
        senha = request.form.get("senha", "")
        form  = {"nome": nome, "email": email}
        if not nome or not email or not senha:
            erro = "Preencha todos os campos."
        elif len(senha) < 6:
            erro = "A senha precisa ter ao menos 6 caracteres."
        else:
            db = get_db()
            try:
                db.execute(
                    "INSERT INTO usuarios (nome, email, senha_hash, creditos) VALUES (?,?,?,?)",
                    (nome, email, generate_password_hash(senha), CREDITOS_GRATIS)
                )
                db.commit()
                u = db.execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()
                session["uid"] = u["id"]
                return redirect(url_for("index"))
            except Exception as exc:
                rollback_silencioso()
                if is_unique_violation(exc):
                    erro = "Este e-mail já está cadastrado."
                else:
                    raise
    return render_template_string(HTML_AUTH, modo="cadastro", titulo="Cadastrar", erro=erro, form=form)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

# ── rota principal ────────────────────────────────────────────────────────────

@app.route("/")
@login_required
def index():
    u = usuario_logado()
    pode, _ = pode_extrair(u)
    return render_template_string(
        HTML_APP,
        label_plano=label_plano(u),
        assinatura_ativa=plano_ativo(u),
        creditos=u["creditos"],
        bloqueado=not pode,
    )

# ── rotas de extração ─────────────────────────────────────────────────────────

@app.route("/healthz")
def healthz():
    try:
        get_db().execute("SELECT 1")
        return jsonify(ok=True, db=DB_BACKEND, pagamento_simulado=MP_SIMULADO), 200
    except Exception as exc:
        rollback_silencioso()
        return jsonify(ok=False, erro=str(exc)), 500


@app.route("/extrair", methods=["POST"])
@login_required
def extrair():
    u = usuario_logado()
    pode, modo = pode_extrair(u)
    if not pode:
        return jsonify(ok=False, erro="Sem créditos ou plano ativo. Escolha um plano.")

    if "pdf" not in request.files:
        return jsonify(ok=False, erro="Nenhum arquivo enviado.")
    arq = request.files["pdf"]
    if not arq.filename.lower().endswith(".pdf"):
        return jsonify(ok=False, erro="Arquivo precisa ser um PDF.")

    try:
        enderecos = extrair_enderecos(arq.read())
    except Exception as e:
        return jsonify(ok=False, erro=str(e))

    if not enderecos:
        return jsonify(ok=False, erro="Nenhum endereço encontrado. O PDF precisa ter colunas Endereço, Bairro e CEP.")

    db = get_db()
    creditos_restantes = None
    if modo == "credito":
        db.execute("UPDATE usuarios SET creditos = creditos - 1 WHERE id=?", (u["id"],))
        novo = db.execute("SELECT creditos FROM usuarios WHERE id=?", (u["id"],)).fetchone()
        creditos_restantes = novo["creditos"]

    db.execute("INSERT INTO usos (usuario_id, enderecos) VALUES (?,?)", (u["id"], len(enderecos)))
    db.commit()

    return jsonify(ok=True, enderecos=enderecos, creditos_restantes=creditos_restantes)


@app.route("/baixar/<fmt>", methods=["POST"])
@login_required
def baixar(fmt):
    data = request.get_json()
    enderecos = data.get("enderecos", [])
    nome = data.get("nome", "enderecos")
    if fmt == "xlsx":
        buf = gerar_xlsx(enderecos)
        return send_file(io.BytesIO(buf),
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                         as_attachment=True, download_name=f"{nome}.xlsx")
    buf = gerar_txt(enderecos)
    return send_file(io.BytesIO(buf), mimetype="text/plain; charset=utf-8",
                     as_attachment=True, download_name=f"{nome}.txt")

# ── rotas de planos e pagamento ───────────────────────────────────────────────

init_db()

@app.route("/planos")
def planos():
    return render_template_string(HTML_PLANOS, logado=bool(session.get("uid")))


@app.route("/assinar/<plano_key>", methods=["GET", "POST"])
@login_required
def assinar(plano_key):
    if plano_key not in PLANOS:
        return redirect(url_for("planos"))

    plano = PLANOS[plano_key]

    if request.method == "POST":
        if MP_SIMULADO:
            uid = session["uid"]
            pagamento_id = registrar_pagamento_pendente(uid, plano_key, plano["valor"])
            confirmar_pagamento(pagamento_id, status="aprovado")
            return redirect(url_for("pagamento_sucesso"))
        else:
            uid = session["uid"]
            pagamento_id = registrar_pagamento_pendente(uid, plano_key, plano["valor"])
            base = request.host_url.rstrip("/")
            preference_data = {
                "items": [{"title": f"Extrator GAN — {plano['nome']}",
                           "quantity": 1, "unit_price": plano["valor"]}],
                "back_urls": {
                    "success": f"{base}/pagamento/sucesso",
                    "failure": f"{base}/pagamento/falha",
                    "pending": f"{base}/pagamento/pendente",
                },
                "auto_return": "approved",
                "notification_url": f"{base}/webhook/mp",
                "external_reference": str(pagamento_id),
                "metadata": {"uid": uid, "plano_key": plano_key, "pagamento_id": pagamento_id},
            }
            result = MP_SDK.preference().create(preference_data)
            if result["status"] == 201:
                init_point = result["response"]["init_point"]
                get_db().execute(
                    "UPDATE pagamentos SET mp_id=? WHERE id=?",
                    (result["response"]["id"], pagamento_id)
                )
                get_db().commit()
                return redirect(init_point)
            get_db().execute("UPDATE pagamentos SET status=? WHERE id=?", ("falha", pagamento_id))
            get_db().commit()
            return redirect(url_for("pagamento_falha"))

    return render_template_string(HTML_COMPRAR, plano=plano, simulado=MP_SIMULADO)


@app.route("/pagamento/sucesso")
@login_required
def pagamento_sucesso():
    if not MP_SIMULADO and MP_SDK and request.args.get("payment_id"):
        result = MP_SDK.payment().get(request.args["payment_id"])
        if result["status"] == 200:
            payment = result["response"]
            pagamento_id = payment.get("external_reference") or payment.get("metadata", {}).get("pagamento_id")
            if pagamento_id and payment.get("status") == "approved":
                confirmar_pagamento(int(pagamento_id), str(payment.get("id")), "aprovado")
    return render_template_string(HTML_STATUS_PGTO,
        icone="✅", titulo="Pagamento aprovado!",
        msg="Seu acesso foi liberado. Bom uso!")


@app.route("/pagamento/pendente")
@login_required
def pagamento_pendente():
    return render_template_string(HTML_STATUS_PGTO,
        icone="⏳", titulo="Pagamento pendente",
        msg="Assim que o pagamento for confirmado, seu acesso será liberado automaticamente.")


@app.route("/pagamento/falha")
@login_required
def pagamento_falha():
    return render_template_string(HTML_STATUS_PGTO,
        icone="❌", titulo="Pagamento não realizado",
        msg="Houve um problema com seu pagamento. Tente novamente.")


@app.route("/webhook/mp", methods=["POST"])
def webhook_mp():
    if MP_SIMULADO or not MP_SDK:
        return "", 200
    if not validar_webhook_mp(request):
        return "", 401
    data = request.get_json(silent=True) or {}
    if data.get("type") != "payment":
        return "", 200
    mp_payment_id = str(data.get("data", {}).get("id", ""))
    if not mp_payment_id:
        return "", 200

    result = MP_SDK.payment().get(mp_payment_id)
    if result["status"] != 200:
        return "", 200

    payment = result["response"]
    status = payment.get("status")
    meta = payment.get("metadata", {})
    pagamento_id = payment.get("external_reference") or meta.get("pagamento_id")
    if pagamento_id:
        confirmar_pagamento(int(pagamento_id), mp_payment_id, status)

    return "", 200

# ── inicialização ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    porta = int(os.environ.get("PORT", 5001))
    if porta == 5001:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://localhost:{porta}")).start()
        print(f"Abrindo em http://localhost:{porta}")
        if MP_SIMULADO:
            print("⚠  Modo simulado ativo (MP_ACCESS_TOKEN não configurado)")
    app.run(host="0.0.0.0", port=porta, debug=False)
