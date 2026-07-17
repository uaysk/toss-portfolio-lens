import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { RunJobRepository } from "./run-job-repository.js";

describe("RunJobRepository dialect boundary", () => {
  it("SQLite에서 external queue schema 생성을 fail-closed 한다", async () => {
    const database = new SqliteDatabase(":memory:");
    await expect(new RunJobRepository(database).initialize()).rejects.toThrow("PostgreSQL");
    await database.close();
  });
});
