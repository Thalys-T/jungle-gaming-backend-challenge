# Jungle Gaming — Distributed Wagering Processor

Backend financeiro com Bun 1.x, NestJS, MikroORM, PostgreSQL e SQS/LocalStack. O projeto mantém os testes e o domínio originais e acrescenta processamento distribuído, API, ledger persistente, inbox/outbox e reconciliação.

## Iniciar (Docker Desktop aberto)

Na pasta que contém `compose.yaml`:

```powershell
docker compose up --build -d
```

O Compose inicia PostgreSQL, LocalStack, aplica as migrations e inicia **três instâncias independentes** da aplicação:

- http://localhost:3000
- http://localhost:3001
- http://localhost:3002

```powershell
docker compose logs -f app1 app2 app3
Invoke-RestMethod http://localhost:3000/health/ready
```

Não há autenticação neste ambiente de desenvolvimento. Leia a decisão em `ARCHITECTURE.md`.

## Desenvolvimento no host

Bun 1.x instalado. A referência reproduzível do Docker é Bun 1.3.5; o projeto também usa APIs disponíveis em Bun 1.4.x.

```powershell
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run migrate
bun run start
```

Configuração padrão: PostgreSQL `127.0.0.1:5433`, usuário `jungle`, senha de desenvolvimento `jungle_local`, database `jungle_wagering`. LocalStack `http://127.0.0.1:4566`. Overrides: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `PORT`. `WORKERS=false` desativa workers na API; `bun run worker` inicia worker independente.

As credenciais locais não são credenciais de produção. Não use endpoints AWS reais com essa configuração.

## Exemplo PowerShell

```powershell
$wallet = Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType 'application/json' -Body (@{ playerId = [guid]::NewGuid().ToString(); initialBalance = @{amount='100.00';currency='BRL'} } | ConvertTo-Json)
$external = [guid]::NewGuid().ToString()
$body = @{ providerId='provider-a'; externalTransactionId=$external; playerId=$wallet.playerId; walletId=$wallet.id; roundId='round-1'; gameId='game-1'; kind='BET'; money=@{amount='25.00';currency='BRL'} } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions -ContentType 'application/json' -Headers @{'Idempotency-Key'="provider-a:$external"} -Body $body
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets/$($wallet.id)/reconciliation"
```

Reenvie o mesmo `$body` e header para verificar replay histórico.

## Rotas

| Método | Rota                                                                  |
| ------ | --------------------------------------------------------------------- |
| POST   | `/wallets`                                                            |
| GET    | `/wallets/:walletId`                                                  |
| GET    | `/wallets/:walletId/ledger?limit=50&cursor=...`                       |
| POST   | `/wallets/:walletId/reconciliation`                                   |
| POST   | `/wagering/transactions` (header `Idempotency-Key` obrigatório)       |
| GET    | `/wagering/transactions/:transactionId`                               |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` |
| GET    | `/health/live`                                                        |
| GET    | `/health/ready`                                                       |
| GET    | `/metrics` (Prometheus)                                               |

HTTP: 201 para criação de wallet; 200 para processamento/replay; 202 para referência pendente; 400 para contrato inválido; 404 para recurso inexistente; 409 para conflito; 422 para rejeição financeira; 503 para infraestrutura indisponível. Replays conservam o status financeiro original e o saldo histórico. Transação de abertura pode ser consultada pelo ID no ledger.

## Filas

O serviço cria filas FIFO `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. A última recebe eventos publicados pela outbox; não alimenta o consumidor de comandos.

Envelope de entrada:

```json
{
  "messageId": "identidade-estavel-do-comando",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-02T10:00:00.000Z",
  "data": {
    "idempotencyKey": "provider-a:transaction-123",
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "walletId": "UUID-DA-WALLET",
    "playerId": "UUID-DO-PLAYER",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

`MessageGroupId` deve ser a wallet; `MessageDeduplicationId` é identidade do transporte. A garantia final é SQL, independentemente de deduplicação FIFO. Publique o JSON por `awslocal sqs send-message` ou pelo SDK. `Queue.send` está disponível em `src/infrastructure/queue.ts`.

## Testes

Use uma base **exclusiva de desenvolvimento/testes**, pois testes criam registros auditáveis e não apagam ledger. PostgreSQL deve estar migrado; a suíte de integração aplica migrations pendentes.

```powershell
bun run typecheck
bun run test
# Docker: PostgreSQL ativo
bun run test:integration
bun run test:distributed
# PostgreSQL + LocalStack ativos. Pare APIs/workers para evitar consumidores concorrendo com os cenários controlados:
docker compose stop app1 app2 app3
bun run test:messaging
```

`test:distributed` cria três processos Bun reais, envia 50 duplicatas, disputa saldo, processa wallets distintas e verifica replay após reinício. A suíte de mensageria testa SQS real, dois publishers, redelivery, DLQ, retry e morte depois do commit/antes do ack. Pode levar mais de um minuto pela expiração real da visibilidade SQS.

`CRASH_AFTER_COMMIT=1` é um failpoint **somente para testes de crash**, termina o worker com código 99 entre commit e ack. `CRASH_AFTER_PUBLISH=1` encerra o publisher com código 98 depois do envio e antes de confirmar a marcação SQL. Nunca habilite esses failpoints no uso normal.

Os testes de falha transitória do consumidor usam filas exclusivas e PostgreSQL/LocalStack reais, verificando recuperação sem duplicação e redrive após cinco recebimentos. Veja `VALIDATION.md` para o ambiente e os resultados da validação.

## Migrations e dados

`bun run migrate` aplica migrations versionadas. `bun scripts/rollback.ts` desfaz a última migration. Rollbacks podem remover proteções e tabelas financeiras, conforme a migration; use somente em uma base descartável.

A migration inicial foi preservada. A segunda acrescenta tabelas financeiras, índices, constraints, triggers e imutabilidade. A terceira protege a correspondência entre transações e ledger, direção, referências, sequência de saldos e versões. Como parte do schema usa SQL explícito, **não use schema update/drop ou gere migrations automaticamente a partir apenas de WalletSchema**: isso não representa as demais tabelas/triggers. Novas mudanças devem ser migrations SQL revisadas e reversíveis.

`docker compose down` preserva volumes; `docker compose down -v` destrói dados locais.
