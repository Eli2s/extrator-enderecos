# Extrator de Enderecos GAN

Aplicacao SaaS para extrair enderecos de listas GAN em PDF, com login, creditos gratis, planos e exportacao em Excel/TXT.

## Recursos

- Upload de PDF e extracao automatica de `Endereco`, `CEP` e `Bairro`
- Cadastro, login e sessao
- Creditos gratis no cadastro
- Bloqueio de uso sem credito ou assinatura
- Pagina de planos e integracao com Mercado Pago
- Modo local com SQLite
- Modo producao com PostgreSQL via `DATABASE_URL`

## Rodando localmente

Instale as dependencias:

```bash
pip install -r requirements.txt
```

Variaveis opcionais para desenvolvimento:

```env
SECRET_KEY=troque-isso
MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=
SESSION_COOKIE_SECURE=0
```

Execute:

```bash
python app.py
```

O app abre em `http://localhost:5001`.

## Producao no Render

O blueprint em `render.yaml` ja provisiona:

- web service Python
- PostgreSQL gerenciado
- `DATABASE_URL` vinda do banco
- `SECRET_KEY` gerada automaticamente
- `SESSION_COOKIE_SECURE=1`
- health check em `/healthz`

Depois do deploy, ainda e necessario preencher manualmente:

- `MP_ACCESS_TOKEN`
- `MP_WEBHOOK_SECRET`

Sem `MP_ACCESS_TOKEN`, o checkout fica em modo simulado.

## Webhook do Mercado Pago

Quando `MP_WEBHOOK_SECRET` esta configurado, o endpoint `/webhook/mp` valida `x-signature` e `x-request-id` antes de processar a notificacao. A validacao segue o modelo oficial de webhooks com HMAC SHA-256.

Fontes oficiais:

- https://www.mercadopago.com.br/developers/en/docs/checkout-pro/payment-notifications
- https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications

## Estrutura

```text
app.py
requirements.txt
render.yaml
```
