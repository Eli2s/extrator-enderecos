# Port Node da extracao

Versao Node.js focada em upload, extracao e exportacao de PDFs GAN. Sem login, sem planos e sem pagamento.

## Rodar

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

## Teste por linha de comando

```bash
npm run extract -- caminho/do/arquivo.pdf
```

## Objetivo

- validar upload
- validar extracao
- validar download TXT/XLSX

Sem login, sem planos, sem pagamento.

## Publicacao

Para publicar em hospedagem Node:

- o app sobe com `npm start`
- usa `PORT` do ambiente automaticamente
- responde `GET /healthz`
- requer Node `>= 20`

Se a plataforma pedir deteccao por `package.json`, esta pasta ja atende esse requisito.
