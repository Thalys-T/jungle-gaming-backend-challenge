import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { WalletSchema } from "./src/infrastructure/database/entities/wallet.entity";

export default defineConfig({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? "5433"),
  user: process.env.DB_USER ?? "jungle",
  password: process.env.DB_PASSWORD ?? "jungle_local",
  dbName: process.env.DB_NAME ?? "jungle_wagering",

  entities: [WalletSchema],
  extensions: [Migrator],

  migrations: {
    path: "./src/infrastructure/database/migrations",
    pathTs: "./src/infrastructure/database/migrations",
    emit: "ts",
  },
});
