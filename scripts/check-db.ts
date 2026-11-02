import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const result = await orm.em
      .getConnection()
      .execute("SELECT current_database(), current_user");

    console.log("Conexão pelo MikroORM confirmada:");
    console.table(result);
  } finally {
    await orm.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
