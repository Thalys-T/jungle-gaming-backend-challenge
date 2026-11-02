# Jungle Gaming — Distributed Wagering Processor

Serviço financeiro distribuído para processar apostas com Bun 1.x, NestJS, MikroORM, PostgreSQL e SQS/LocalStack. Recebe operações por HTTP e pela fila usando o mesmo caso de uso, com dinheiro decimal exato, idempotência persistente, controle de concorrência por carteira, ledger imutável, inbox/outbox transacionais e reconciliação.

## Pré-requisitos

- Git para clonar o repositório.
- Docker Engine com Docker Compose v2, ou Docker Desktop aberto e configurado para containers Linux.
- Portas locais 3000, 3001, 3002, 5433 e 4566 disponíveis para a configuração padrão.
- Para executar a aplicação ou os testes diretamente no computador: Bun 1.x. A imagem Docker usa Bun 1.3.5; a checagem de tipos também foi validada no Windows com Bun 1.4.4.

A execução da aplicação e dos testes em containers não exige Bun, PostgreSQL nem AWS CLI instalados no computador. Os exemplos com variáveis e `Invoke-RestMethod` usam PowerShell.

## Iniciar com Docker

```powershell
git clone https://github.com/Thalys-T/jungle-gaming-backend-challenge.git
cd jungle-gaming-backend-challenge
docker compose up --build -d
```

Se já clonou o projeto, execute o comando do Compose na pasta que contém `compose.yaml`.

O Compose inicia PostgreSQL, LocalStack, aplica as migrations e inicia **três instâncias independentes** da aplicação:

- http://localhost:3000
- http://localhost:3001
- http://localhost:3002

```powershell
docker compose logs -f app1 app2 app3
Invoke-RestMethod http://localhost:3000/health/ready
```

Autenticação não foi implementada nesta entrega, conforme permitido pelo desafio. O ponto de extensão e o desenho com Identity Provider externo estão descritos em [ARCHITECTURE.md](ARCHITECTURE.md#autenticação).

## Desenvolvimento no host

Com Bun 1.x instalado, execute na raiz do repositório. Caso as três instâncias do Compose estejam ativas, pare-as para liberar a porta 3000 e evitar workers concorrentes com a execução local:

```powershell
docker compose stop app1 app2 app3
bun install --frozen-lockfile
docker compose up -d --wait postgres localstack
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

### Executar todas as suítes em Docker

O comando `bun run test:all` executa a checagem de tipos e, em sequência, os testes unitários, de integração, distribuídos e de mensageria. O procedimento abaixo executa esse comando dentro do container, sem exigir Bun no computador.

Use uma base **exclusiva para testes**, pois as suítes criam registros financeiros auditáveis e não apagam o ledger. Pare as instâncias da aplicação e qualquer worker iniciado manualmente antes dos testes: parte da suíte de mensageria usa as mesmas filas do LocalStack local.

```powershell
docker compose stop app1 app2 app3
docker compose up -d --wait postgres localstack
docker compose build migrate

# Nome exclusivo para cada execução; mantém os dados da aplicação separados.
$testDatabase = 'jungle_tests_' + [guid]::NewGuid().ToString('N')
docker compose exec -T postgres createdb -U jungle $testDatabase
docker compose run --rm -T --no-deps -e "DB_NAME=$testDatabase" migrate bun run test:all
```

As suítes aplicam as migrations na base de teste. Os registros e a base ficam preservados após a execução. O resultado validado foi **82 testes passando, nenhuma falha**; ambiente e cobertura estão em [VALIDATION.md](VALIDATION.md).

Para retomar as três instâncias após os testes:

```powershell
docker compose up -d app1 app2 app3
```

### Comandos disponíveis

Para executar comandos diretamente no computador, instale as dependências com `bun install --frozen-lockfile`. Os testes de integração, distribuídos e mensageria exigem configurar `DB_NAME` para uma base exclusiva existente; por padrão, a configuração aponta para a base da aplicação, `jungle_wagering`.

| Comando | Verificação | Dependências externas |
| --- | --- | --- |
| `bun run typecheck` | TypeScript estrito | Nenhuma |
| `bun run test` | Unidade | Nenhuma |
| `bun run test:integration` | Persistência, constraints, migrations e HTTP | PostgreSQL |
| `bun run test:distributed` | Concorrência com três processos | PostgreSQL |
| `bun run test:messaging` | SQS, outbox, retry, DLQ e recuperação | PostgreSQL e LocalStack |
| `bun run test:all` | Todas as verificações acima | PostgreSQL e LocalStack |

`test:distributed` cria três processos Bun reais, envia 50 duplicatas, disputa saldo, processa wallets distintas e verifica replay após reinício. A suíte de mensageria testa SQS real, dois publishers, redelivery, DLQ, retry e morte depois do commit/antes do ack. Pode levar mais de um minuto pela expiração real da visibilidade SQS.

`CRASH_AFTER_COMMIT=1` é um failpoint **somente para testes de crash**, termina o worker com código 99 entre commit e ack. `CRASH_AFTER_PUBLISH=1` encerra o publisher com código 98 depois do envio e antes de confirmar a marcação SQL. Nunca habilite esses failpoints no uso normal.

Os testes de falha transitória do consumidor usam filas exclusivas e PostgreSQL/LocalStack reais, verificando recuperação sem duplicação e redrive após cinco recebimentos. Não foi realizado benchmark de carga. As decisões técnicas e os limites da solução estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Migrations e dados

`bun run migrate` aplica migrations versionadas. `bun scripts/rollback.ts` desfaz a última migration. Rollbacks podem remover proteções e tabelas financeiras, conforme a migration; use somente em uma base descartável.

A migration inicial foi preservada. A segunda acrescenta tabelas financeiras, índices, constraints, triggers e imutabilidade. A terceira protege a correspondência entre transações e ledger, direção, referências, sequência de saldos e versões. Como parte do schema usa SQL explícito, **não use schema update/drop ou gere migrations automaticamente a partir apenas de WalletSchema**: isso não representa as demais tabelas/triggers. Novas mudanças devem ser migrations SQL revisadas e reversíveis.

`docker compose down` preserva volumes; `docker compose down -v` destrói dados locais.
