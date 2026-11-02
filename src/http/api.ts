import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Get,
  Headers,
  HttpException,
  Module,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ExceptionFilter, CanActivate } from "@nestjs/common";
import { Processor, rows } from "../application/processor";
import { AppError } from "../application/contracts";
import { Queue } from "../infrastructure/queue";
import { metrics, log } from "../infrastructure/observability";
// Extension point for external OIDC verification + provider claim binding. Deliberately disabled locally.
export class ProviderIdentityGuard implements CanActivate {
  canActivate() {
    return true;
  }
}
export function createModule(p: Processor, q: Queue) {
  @Controller()
  @UseGuards(ProviderIdentityGuard)
  class Api {
    @Post("wallets") create(@Body() body: any) {
      return p.createWallet(body);
    }
    @Get("wallets/:id") wallet(@Param("id") id: string) {
      return p.wallet(id);
    }
    @Get("wallets/:id/ledger") ledger(
      @Param("id") id: string,
      @Query("cursor") cursor?: string,
      @Query("limit") limit?: string,
    ) {
      return p.ledger(id, cursor, limit);
    }
    @Post("wallets/:id/reconciliation") reconcile(@Param("id") id: string) {
      return p.reconcile(id);
    }
    @Post("wagering/transactions") async submit(
      @Body() body: any,
      @Headers("idempotency-key") key: string,
      @Res({ passthrough: true }) res: any,
    ) {
      const result = await p.submit(body, key);
      res.status(
        result.status === "REJECTED"
          ? 422
          : result.status.startsWith("PENDING")
            ? 202
            : 200,
      );
      return result;
    }
    @Get("wagering/transactions/:id") transaction(@Param("id") id: string) {
      return p.transaction(id);
    }
    @Get("providers/:provider/wagering/transactions/:external") external(
      @Param("provider") provider: string,
      @Param("external") external: string,
    ) {
      return p.external(provider, external);
    }
    @Get("metrics") async metric(@Res() res: any) {
      const [r] = await rows(
        p.orm.em.fork(),
        `select coalesce(extract(epoch from now()-min(occurred_at)),0)::float as lag from outbox_messages where published_at is null`,
      );
      res.type("text/plain").send(metrics.render(r.lag));
    }
  }
  @Controller("health")
  class Health {
    @Get("live") live() {
      return { status: "ok" };
    }
    @Get("ready") async ready() {
      try {
        await rows(p.orm.em.fork(), "select 1");
        await q.ready();
        return { status: "ready" };
      } catch {
        throw new AppError("DEPENDENCY_UNAVAILABLE", 503);
      }
    }
  }
  @Module({ controllers: [Api, Health], providers: [ProviderIdentityGuard] })
  class AppModule {}
  return AppModule;
}
@Catch()
export class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (error instanceof AppError) {
      res.status(error.httpStatus).json({ failureCode: error.code });
      return;
    }
    if (error instanceof HttpException) {
      res.status(error.getStatus()).json({ failureCode: "HTTP_ERROR" });
      return;
    }
    log("request_failed", { code: "INFRASTRUCTURE_UNAVAILABLE" });
    res.status(503).json({ failureCode: "INFRASTRUCTURE_UNAVAILABLE" });
  }
}
