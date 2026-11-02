import { connect } from "./infrastructure/database/connection";
import { Processor } from "./application/processor";
import { Queue, Workers } from "./infrastructure/queue";
const orm = await connect(),
  q = new Queue();
await q.init();
const w = new Workers(new Processor(orm), q);
w.start();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await w.stop();
  await orm.close();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
