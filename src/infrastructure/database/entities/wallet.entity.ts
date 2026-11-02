import { EntitySchema } from "@mikro-orm/core";

export class WalletEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletEntity>({
  class: WalletEntity,
  tableName: "wallets",

  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    balance: {
      type: "decimal",
      precision: 20,
      scale: 2,
    },
    version: { type: "integer" },
    createdAt: { type: "Date", columnType: "timestamptz" },
    updatedAt: { type: "Date", columnType: "timestamptz" },
  },

  uniques: [
    {
      name: "wallets_player_currency_unique",
      properties: ["playerId", "currency"],
    },
  ],

  checks: [
    {
      name: "wallets_balance_nonnegative",
      expression: "balance >= 0",
    },
    {
      name: "wallets_version_positive",
      expression: "version >= 1",
    },
  ],
});
