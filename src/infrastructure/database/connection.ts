import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../../mikro-orm.config";
export const connect = () => MikroORM.init(config);
