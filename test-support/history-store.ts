import { PortfolioHistoryStore } from "../server/history.js";
import { PGliteDatabase } from "./pglite-database.js";

export function openTestHistoryStore(): Promise<PortfolioHistoryStore> {
  return PortfolioHistoryStore.open(new PGliteDatabase());
}
