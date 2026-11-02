import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { connect } from "./infrastructure/database/connection";
import { Processor } from "./application/processor";
import { Queue, Workers } from "./infrastructure/queue";
import { createModule, Errors } from "./http/api";
const orm = await connect();
const processor = new Processor(orm);
const queue = new Queue();
await queue.init();
const app = await NestFactory.create(createModule(processor, queue), {
  logger: false,
});
app.useGlobalFilters(new Errors());
const workers = new Workers(processor, queue);
if (process.env.WORKERS !== "false") workers.start();
await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
console.log(
  JSON.stringify({ event: "listening", port: process.env.PORT ?? 3000 }),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await workers.stop();
  await orm.close();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
