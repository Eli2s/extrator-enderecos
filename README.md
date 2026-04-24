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

O app cria as tabelas automaticamente no primeiro boot:

- `users`
- `plans`
- `subscriptions`
- `transactions`
- `usage_logs`

## Healthcheck

```text
GET /healthz
```

Resposta esperada:

```json
{"ok":true,"runtime":"node","service":"extrator-enderecos-saas","database":"mysql"}
```
