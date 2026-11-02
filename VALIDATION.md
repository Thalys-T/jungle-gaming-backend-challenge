# Validação

Data: 02/11/2026.

Execução completa de `bun run test:all` em Docker: **82 testes passaram, nenhuma falha**.

| Suíte | Resultado |
| --- | --- |
| TypeScript estrito | passou |
| Unidade | 53 passaram |
| Integração PostgreSQL e HTTP | 19 passaram |
| Concorrência com três processos | 1 passou |
| Mensageria e recuperação | 9 passaram |

Ambiente: Bun 1.3.5, TypeScript 5.9.3, PostgreSQL 17 e LocalStack 4.10 em containers. A checagem de tipos também passou no Windows com Bun 1.4.4.

`docker compose up -d --build` também foi executado com sucesso: migrations aplicadas e as três instâncias responderam `ready` em `/health/ready`, nas portas 3000, 3001 e 3002.

Os testes incluem migrations reversíveis, constraints por SQL direto, direção e encadeamento do ledger, versão da wallet, atomicidade, 50 duplicatas concorrentes, disputa de saldo, referências fora de ordem, inbox, publishers concorrentes, retry transitório do consumidor com recuperação e redrive para DLQ, crash após commit/antes do ack e crash após publicação/antes da marcação. PostgreSQL e SQS não são substituídos por mocks.

Para reproduzir, com Docker Desktop aberto e sem APIs/workers consumindo as filas de teste:

```powershell
docker compose up -d postgres localstack
docker compose build migrate
docker compose exec -T postgres createdb -U jungle jungle_tests
docker compose run --rm -T --no-deps -e DB_NAME=jungle_tests migrate bun run test:all
```

Use um nome de base novo em cada execução para isolamento. As suítes geram registros financeiros auditáveis e a execução de mensageria leva alguns minutos por usar os intervalos reais de visibilidade e backoff.

Não foi realizado benchmark de carga. Autenticação produtiva foi deixada como ponto de extensão, conforme permitido pelo desafio e descrito em `ARCHITECTURE.md`.
