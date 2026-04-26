# Extrator GAN SaaS

Aplicacao Node.js para:

- cadastro e login
- compra de planos
- extracao de enderecos de PDFs GAN
- download em XLSX e TXT

## Requisitos

- Node.js 20+
- MySQL/MariaDB

## Variaveis de ambiente

Crie um `.env` com:

```env
HOST=0.0.0.0
PORT=3000
SESSION_SECRET=troque-isto

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=seu_banco
DB_USER=seu_usuario
DB_PASSWORD=sua_senha

BASE_URL=https://seu-dominio.com
MP_ACCESS_TOKEN=
MP_PUBLIC_KEY=
MP_WEBHOOK_SECRET=
MP_WEBHOOK_TOLERANCE_MS=300000
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=
EMAIL_VERIFICATION_TOKEN_TTL_MS=1800000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ADMIN_NAME=Administrador
ADMIN_EMAIL=admin@seu-dominio.com
ADMIN_PASSWORD=troque-por-uma-senha-admin-forte
```

## Rodar localmente

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

## Hostinger

Para publicar na Hostinger Node:

1. importe o repositório
2. use Node 20+
3. start command: `npm start`
4. configure as variaveis de ambiente do bloco acima
5. configure `NODE_ENV=production`
6. aponte `BASE_URL` para o dominio final com `https://`

O app cria as tabelas automaticamente no primeiro boot:

- `users`
- `plans`
- `subscriptions`
- `transactions`
- `usage_logs`
- `sessions`

## Mercado Pago

- Sem `MP_ACCESS_TOKEN`, o checkout fica em modo simulado.
- Com `MP_ACCESS_TOKEN` e `MP_PUBLIC_KEY`, o app usa Checkout Transparente com Pix e cartao.
- Com `MP_ACCESS_TOKEN`, configure tambem `MP_WEBHOOK_SECRET` para validar `x-signature` no webhook.
- Em producao, use `BASE_URL` com `https://`.
- Com SMTP configurado, o app envia link de confirmacao de e-mail.
- Com `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`, o login com Google fica disponivel.

## Checklist de Producao

Antes de publicar:

1. configure `NODE_ENV=production`
2. configure `SESSION_SECRET` com pelo menos 32 caracteres
3. configure `BASE_URL` com o dominio final em `https://`
4. configure `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY` e `MP_WEBHOOK_SECRET`
5. confirme que o banco MySQL da Hostinger esta acessivel pelo app em producao
6. confirme que o webhook do Mercado Pago aponta para `https://seu-dominio.com/pagamento/webhook`
7. revise se `credencias.txt` e `credencias.json` nao estao versionados
8. teste `GET /healthz`
9. teste um pagamento real de Pix
10. teste um pagamento real de cartao
11. confirme no banco se `transactions` ficou `approved` e se a assinatura foi ativada

## Healthcheck

```text
GET /healthz
```

Resposta esperada:

```json
{"ok":true,"runtime":"node","service":"extrator-enderecos-saas","database":"mysql"}
```
