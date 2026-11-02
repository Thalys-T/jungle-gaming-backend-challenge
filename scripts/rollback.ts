import { connect } from "../src/infrastructure/database/connection";
const orm = await connect();
try {
  await orm.getMigrator().down();
} finally {
  await orm.close();
}
