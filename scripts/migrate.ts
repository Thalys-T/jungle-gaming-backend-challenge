import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const migrations = await orm.getMigrator().up();

    for (const migration of migrations) {
      console.log("Migration aplicada:", migration.name);
    }

    console.log("Banco atualizado.");
  } finally {
    await orm.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
