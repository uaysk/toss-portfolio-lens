import type { AppConfig } from "./env.js";

export async function bootstrap(config: AppConfig): Promise<void> {
  const { ApplicationRuntime } = await import("./application-runtime.js");
  await ApplicationRuntime.start(config);
}
