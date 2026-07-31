import { ApplicationRuntime } from "./application-runtime.js";
import type { AppConfig } from "./env.js";

export async function bootstrap(config: AppConfig): Promise<void> {
  await ApplicationRuntime.start(config);
}
