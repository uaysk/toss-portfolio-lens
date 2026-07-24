import { bootstrap } from "./bootstrap.js";
import { loadConfig } from "./env.js";

const config = loadConfig();
await bootstrap(config);
