import { connect } from "../src/infrastructure/database/connection";
import { Processor } from "../src/application/processor";
import { Queue } from "../src/infrastructure/queue";
const orm = await connect(),
  q = new Queue();
try {
  await q.init();
  await q.publishOne(new Processor(orm));
} finally {
  q.client.destroy();
  await orm.close();
}
