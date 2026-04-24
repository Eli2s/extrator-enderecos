# CHECKPOINT — SaaS Implementation

> Lido por Claude/Codex para continuar de onde parou.
> Atualizado a cada fase concluída. Checar git log para confirmação dos commits.

## Projeto
- **Stack**: Node.js (ESM) + Express + better-sqlite3
- **Arquivo principal**: `server.js`
- **DB**: `saas.db` (ignorado no git)
- **Módulos**: `src/db.js`, `src/auth.js`, `src/plans.js`

## Planos e preços
| id | Nome | Preço | Créditos | Validade |
|----|------|-------|----------|----------|
| avulso_1 | 1 extração | R$2,90 | 1 | sem validade |
| avulso_5 | 5 extrações | R$9,90 | 5 | sem validade |
| semanal | Semanal | R$9,90 | ilimitado | 7 dias |
| mensal | Mensal | R$29,90 | ilimitado | 30 dias |

## Variáveis de ambiente (.env)
```
SESSION_SECRET=troque_por_string_aleatoria
MP_ACCESS_TOKEN=         # Mercado Pago (vazio = modo simulação)
MP_PUBLIC_KEY=           # Mercado Pago public key
BASE_URL=http://localhost:3000
PORT=3000
```

## Status das fases

### ✅ FASE 0 — Core extrator (CONCLUÍDA)
- Extração PDF → XLSX/TXT funcionando
- Seletor de campos (endereço, nº separado, bairro, CEP)
- 265/265 entradas extraídas (sem deduplicação)
- Visual: preto/branco/vermelho (Corinthians)
- Deploy config no Render presente

### ✅ FASE 1 — Banco de dados + Auth (CONCLUÍDA)
- `src/db.js` — Schema SQLite, seed de planos, helpers: getActiveSubscription, activateSubscription, consumeCredit, logUsage, createTransaction, approveTransaction
- `src/auth.js` — createUser, loginUser, getUserById, requireAuth
- Instalado: `better-sqlite3 bcryptjs express-session mercadopago`

### ✅ FASE 2 — Páginas UI (CONCLUÍDA)
- `/login` — form com erro inline
- `/register` — form com validação
- `/planos` — cards de preço (visitante vê "Criar conta", logado vê "Comprar")
- `/dashboard` — créditos, validade, histórico de uso
- `/` — landing (visitante) | "sem plano" (logado sem sub) | ferramenta (logado com sub)
- Topbar contextual: links Planos/Entrar/Criar conta OU nome/Dashboard/Sair

### ✅ FASE 3 — Mercado Pago (CONCLUÍDA)
- POST /pagamento/criar/:planId — cria preferência real (ou redireciona para simulação)
- GET/POST /pagamento/simulacao/:planId — aprova pagamento de teste
- GET /pagamento/sucesso|pendente|falha — páginas de retorno
- POST /pagamento/webhook — ativa subscription via approveTransaction

### ✅ FASE 4 — Integração final (CONCLUÍDA)
- /extrair: verifica req.user e getActiveSubscription, retorna 401/402 com JSON, consome crédito e loga uso
- /me: retorna user + subscription JSON
- Topbar dinâmico por estado de autenticação
- Sessão: httpOnly cookie, maxAge 7 dias

## Como continuar (para o Codex)
1. Ler este arquivo CHECKPOINT.md
2. Rodar `git log --oneline -10` para ver o que já foi commitado
3. Verificar qual fase está em progresso
4. Ler os arquivos relevantes antes de editar (Read tool)
5. Implementar a próxima fase seguindo o schema acima
6. Atualizar este CHECKPOINT.md marcando a fase como ✅
7. Commitar e pushar

## Credenciais de teste (admin criado pelo seed)
- Email: `elias@extratorgan.com.br`
- Senha: `Elias@2025`
