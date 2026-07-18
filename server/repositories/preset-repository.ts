import { randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import { applyPortfolioMigrations } from "../migrations.js";

export type PresetSource = {
  type: string;
  [key: string]: unknown;
};

export type PortfolioPresetRecord = {
  id: string;
  ownerSubject: string;
  name: string;
  description: string;
  config: unknown;
  tags: string[];
  source: PresetSource;
  revision: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type PortfolioPresetVersionRecord = {
  id: string;
  presetId: string;
  revision: number;
  snapshot: PortfolioPresetRecord;
  createdAt: number;
};

export type PortfolioPresetListInput = {
  ownerSubject: string;
  search?: string;
  tags?: string[];
  includeDeleted?: boolean;
  limit?: number;
  cursor?: string;
};

export type PortfolioPresetListResult = {
  items: PortfolioPresetRecord[];
  nextCursor?: string;
};

type PresetRow = {
  preset_id: string;
  owner_subject: string;
  name: string;
  description: string;
  config_json: string;
  tags_json: string;
  source_json: string;
  revision: number | string;
  last_used_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
  deleted_at: number | string | null;
};

type VersionRow = {
  version_id: string;
  preset_id: string;
  revision: number | string;
  snapshot_json: string;
  created_at: number | string;
};

export class PresetRevisionConflictError extends Error {
  constructor(
    readonly presetId: string,
    readonly expectedRevision: number,
    readonly currentRevision?: number,
  ) {
    super(`preset revision이 충돌했습니다. expected=${expectedRevision}, current=${currentRevision ?? "missing"}`);
    this.name = "PresetRevisionConflictError";
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`저장된 preset ${label} JSON이 손상되었습니다.`);
  }
}

function tags(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === "string")))
    : [];
}

function source(value: unknown): PresetSource {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string"
    ? value as PresetSource
    : { type: "unknown" };
}

function record(row: PresetRow): PortfolioPresetRecord {
  return {
    id: row.preset_id,
    ownerSubject: row.owner_subject,
    name: row.name,
    description: row.description,
    config: parseJson(row.config_json, "config"),
    tags: tags(parseJson(row.tags_json, "tags")),
    source: source(parseJson(row.source_json, "source")),
    revision: Number(row.revision),
    ...(row.last_used_at !== null ? { lastUsedAt: Number(row.last_used_at) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.deleted_at !== null ? { deletedAt: Number(row.deleted_at) } : {}),
  };
}

function encodeCursor(value: PortfolioPresetRecord): string {
  return Buffer.from(JSON.stringify({ updatedAt: value.updatedAt, id: value.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { updatedAt: number; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.updatedAt) || typeof parsed.id !== "string" || !parsed.id) throw new Error();
    return { updatedAt: Number(parsed.updatedAt), id: parsed.id };
  } catch {
    throw new Error("preset 목록 cursor가 올바르지 않습니다.");
  }
}

function escapedLike(value: string): string {
  return value.replace(/=/g, "==").replace(/%/g, "=%").replace(/_/g, "=_");
}

function snapshot(value: PortfolioPresetRecord): string {
  return json(value);
}

export class PresetRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async initialize(): Promise<void> {
    await applyPortfolioMigrations(this.database);
  }

  async create(input: {
    ownerSubject: string;
    name: string;
    description: string;
    config: unknown;
    tags: string[];
    source: PresetSource;
    id?: string;
    now?: number;
  }): Promise<PortfolioPresetRecord> {
    const id = input.id ?? randomUUID();
    const now = input.now ?? Date.now();
    const created: PortfolioPresetRecord = {
      id,
      ownerSubject: input.ownerSubject,
      name: input.name,
      description: input.description,
      config: input.config,
      tags: input.tags,
      source: input.source,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.database.transaction(async (database) => {
      await database.run(`
        INSERT INTO portfolio_presets (
          preset_id, owner_subject, name, description, config_json, tags_json,
          source_json, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        input.ownerSubject,
        input.name,
        input.description,
        json(input.config),
        json(input.tags),
        json(input.source),
        1,
        now,
        now,
      ]);
      await this.insertVersion(database, created, now);
    });
    const stored = await this.get(id, input.ownerSubject);
    if (!stored) throw new Error("preset을 생성하지 못했습니다.");
    return stored;
  }

  async get(id: string, ownerSubject: string, includeDeleted = false): Promise<PortfolioPresetRecord | undefined> {
    const [row] = await this.database.query<PresetRow>(`
      SELECT * FROM portfolio_presets
      WHERE preset_id = ? AND owner_subject = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}
    `, [id, ownerSubject]);
    return row ? record(row) : undefined;
  }

  async list(input: PortfolioPresetListInput): Promise<PortfolioPresetListResult> {
    const conditions = ["owner_subject = ?"];
    const parameters: unknown[] = [input.ownerSubject];
    if (!input.includeDeleted) conditions.push("deleted_at IS NULL");
    if (input.search?.trim()) {
      const pattern = `%${escapedLike(input.search.trim().toLowerCase())}%`;
      conditions.push(`(
        LOWER(name) LIKE ? ESCAPE '=' OR LOWER(description) LIKE ? ESCAPE '='
      )`);
      parameters.push(pattern, pattern);
    }
    for (const tag of input.tags ?? []) {
      conditions.push("tags_json LIKE ? ESCAPE '='");
      parameters.push(`%${escapedLike(JSON.stringify(tag))}%`);
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      conditions.push("(updated_at < ? OR (updated_at = ? AND preset_id < ?))");
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const rows = await this.database.query<PresetRow>(`
      SELECT * FROM portfolio_presets
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, preset_id DESC
      LIMIT ${limit + 1}
    `, parameters);
    const items = rows.slice(0, limit).map(record);
    return {
      items,
      ...(rows.length > limit && items.length ? { nextCursor: encodeCursor(items.at(-1)!) } : {}),
    };
  }

  async update(input: {
    id: string;
    ownerSubject: string;
    expectedRevision: number;
    name?: string;
    description?: string;
    config?: unknown;
    tags?: string[];
    source?: PresetSource;
    now?: number;
  }): Promise<PortfolioPresetRecord> {
    const now = input.now ?? Date.now();
    return this.database.transaction(async (database) => {
      const lock = database.dialect === "sqlite" ? "" : " FOR UPDATE";
      const [currentRow] = await database.query<PresetRow>(`
        SELECT * FROM portfolio_presets
        WHERE preset_id = ? AND owner_subject = ? AND deleted_at IS NULL${lock}
      `, [input.id, input.ownerSubject]);
      if (!currentRow) throw new PresetRevisionConflictError(input.id, input.expectedRevision);
      const current = record(currentRow);
      if (current.revision !== input.expectedRevision) {
        throw new PresetRevisionConflictError(input.id, input.expectedRevision, current.revision);
      }
      const next: PortfolioPresetRecord = {
        ...current,
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        config: input.config === undefined ? current.config : input.config,
        tags: input.tags ?? current.tags,
        source: input.source ?? current.source,
        revision: current.revision + 1,
        updatedAt: now,
      };
      const updated = await database.run(`
        UPDATE portfolio_presets
        SET name = ?, description = ?, config_json = ?, tags_json = ?, source_json = ?,
            revision = ?, updated_at = ?
        WHERE preset_id = ? AND owner_subject = ? AND revision = ? AND deleted_at IS NULL
      `, [
        next.name,
        next.description,
        json(next.config),
        json(next.tags),
        json(next.source),
        next.revision,
        now,
        input.id,
        input.ownerSubject,
        input.expectedRevision,
      ]);
      if (updated.affectedRows !== 1) {
        const latest = await this.getRevision(database, input.id, input.ownerSubject);
        throw new PresetRevisionConflictError(input.id, input.expectedRevision, latest);
      }
      await this.insertVersion(database, next, now);
      return next;
    });
  }

  async duplicate(input: {
    id: string;
    ownerSubject: string;
    name?: string;
    now?: number;
  }): Promise<PortfolioPresetRecord> {
    const original = await this.get(input.id, input.ownerSubject);
    if (!original) throw new Error("복제할 preset을 찾을 수 없습니다.");
    return this.create({
      ownerSubject: input.ownerSubject,
      name: input.name ?? `${original.name} 복사본`,
      description: original.description,
      config: original.config,
      tags: original.tags,
      source: { type: "preset", presetId: original.id, revision: original.revision },
      now: input.now,
    });
  }

  async softDelete(input: {
    id: string;
    ownerSubject: string;
    expectedRevision?: number;
    now?: number;
  }): Promise<boolean> {
    const now = input.now ?? Date.now();
    return this.database.transaction(async (database) => {
      const lock = database.dialect === "sqlite" ? "" : " FOR UPDATE";
      const [currentRow] = await database.query<PresetRow>(`
        SELECT * FROM portfolio_presets
        WHERE preset_id = ? AND owner_subject = ? AND deleted_at IS NULL${lock}
      `, [input.id, input.ownerSubject]);
      if (!currentRow) return false;
      const current = record(currentRow);
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new PresetRevisionConflictError(input.id, input.expectedRevision, current.revision);
      }
      const deleted: PortfolioPresetRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        deletedAt: now,
      };
      const updated = await database.run(`
        UPDATE portfolio_presets
        SET revision = ?, updated_at = ?, deleted_at = ?
        WHERE preset_id = ? AND owner_subject = ? AND revision = ? AND deleted_at IS NULL
      `, [deleted.revision, now, now, input.id, input.ownerSubject, current.revision]);
      if (updated.affectedRows !== 1) {
        if (input.expectedRevision !== undefined) {
          const latest = await this.getRevision(database, input.id, input.ownerSubject);
          throw new PresetRevisionConflictError(input.id, input.expectedRevision, latest);
        }
        return false;
      }
      await this.insertVersion(database, deleted, now);
      return true;
    });
  }

  async markUsed(id: string, ownerSubject: string, now = Date.now()): Promise<PortfolioPresetRecord | undefined> {
    await this.database.run(`
      UPDATE portfolio_presets SET last_used_at = ?
      WHERE preset_id = ? AND owner_subject = ? AND deleted_at IS NULL
    `, [now, id, ownerSubject]);
    return this.get(id, ownerSubject);
  }

  async getVersions(id: string, ownerSubject: string): Promise<PortfolioPresetVersionRecord[]> {
    const rows = await this.database.query<VersionRow>(`
      SELECT version.version_id, version.preset_id, version.revision,
             version.snapshot_json, version.created_at
      FROM portfolio_preset_versions version
      JOIN portfolio_presets preset ON preset.preset_id = version.preset_id
      WHERE version.preset_id = ? AND preset.owner_subject = ?
      ORDER BY version.revision ASC
    `, [id, ownerSubject]);
    return rows.map((row) => ({
      id: row.version_id,
      presetId: row.preset_id,
      revision: Number(row.revision),
      snapshot: parseJson(row.snapshot_json, "version") as PortfolioPresetRecord,
      createdAt: Number(row.created_at),
    }));
  }

  private async getRevision(database: RelationalDatabase, id: string, ownerSubject: string): Promise<number | undefined> {
    const [row] = await database.query<{ revision: number | string }>(`
      SELECT revision FROM portfolio_presets WHERE preset_id = ? AND owner_subject = ?
    `, [id, ownerSubject]);
    return row ? Number(row.revision) : undefined;
  }

  private insertVersion(
    database: RelationalDatabase,
    value: PortfolioPresetRecord,
    now: number,
  ): Promise<unknown> {
    return database.run(`
      INSERT INTO portfolio_preset_versions (
        version_id, preset_id, revision, snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `, [randomUUID(), value.id, value.revision, snapshot(value), now]);
  }
}
