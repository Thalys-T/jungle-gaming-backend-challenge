import { connect } from "../src/infrastructure/database/connection";
import { Processor } from "../src/application/processor";
const { commands } = JSON.parse(process.argv[2]!);
const orm = await connect();
try {
  const p = new Processor(orm);
  const results = await Promise.all(
    commands.map((c: any) =>
      p.submit(c, c.providerId + ":" + c.externalTransactionId),
    ),
  );
  console.log("RESULT:" + JSON.stringify(results));
} finally {
  await orm.close();
}
