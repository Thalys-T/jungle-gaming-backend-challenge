import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const migration = await orm.getMigrator().createMigration();

    console.log("Migration gerada:", migration.fileName);
    console.log(migration.code);
  } finally {
    await orm.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
