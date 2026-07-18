import {
  PresetRepository,
  type PortfolioPresetListInput,
  type PortfolioPresetListResult,
  type PortfolioPresetRecord,
  type PortfolioPresetVersionRecord,
  type PresetSource,
} from "../repositories/preset-repository.js";

export const PRESET_EXPORT_SCHEMA_VERSION = "portfolio-lens-preset/v1";

export type PresetExport = {
  schema_version: typeof PRESET_EXPORT_SCHEMA_VERSION;
  exported_at: string;
  preset: {
    name: string;
    description: string;
    config: unknown;
    tags: string[];
    source: PresetSource;
  };
};

export class PresetValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "PresetValidationError";
  }
}
function owner(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new PresetValidationError("preset owner 식별자가 올바르지 않습니다.", "ownerSubject");
  }
  return normalized;
}

function name(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new PresetValidationError("preset 이름은 1~200자여야 합니다.", "name");
  }
  return normalized;
}

function description(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length > 2_000) {
    throw new PresetValidationError("preset 설명은 2,000자 이하여야 합니다.", "description");
  }
  return normalized;
}

function normalizedTags(value: readonly string[] | undefined): string[] {
  const normalized = (value ?? []).map((tag) => tag.trim()).filter(Boolean);
  if (normalized.length > 50 || normalized.some((tag) => tag.length > 64)) {
    throw new PresetValidationError("preset tag는 50개 이하, 각 64자 이하여야 합니다.", "tags");
  }
  return Array.from(new Set(normalized)).sort((left, right) => left.localeCompare(right));
}

function jsonSnapshot(value: unknown, field: string): unknown {
  const seen = new Set<object>();
  const validate = (item: unknown, path: string): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new PresetValidationError(`${path}에는 유한한 숫자만 사용할 수 있습니다.`, field);
      return;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new PresetValidationError(`${path}에 순환 참조가 있습니다.`, field);
      seen.add(item);
      item.forEach((child, index) => validate(child, `${path}[${index}]`));
      seen.delete(item);
      return;
    }
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      if (seen.has(item)) throw new PresetValidationError(`${path}에 순환 참조가 있습니다.`, field);
      seen.add(item);
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (child === undefined) continue;
        validate(child, `${path}.${key}`);
      }
      seen.delete(item);
      return;
    }
    throw new PresetValidationError(`${path}는 JSON 값이어야 합니다.`, field);
  };
  validate(value, field);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new PresetValidationError(`${field}는 JSON 값이어야 합니다.`, field);
  return JSON.parse(serialized) as unknown;
}

function presetSource(value: PresetSource | undefined): PresetSource {
  const normalized = value ?? { type: "manual" };
  const copied = jsonSnapshot(normalized, "source");
  if (!copied || typeof copied !== "object" || Array.isArray(copied)
    || typeof (copied as { type?: unknown }).type !== "string"
    || !(copied as { type: string }).type.trim()) {
    throw new PresetValidationError("preset source.type이 필요합니다.", "source");
  }
  return copied as PresetSource;
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PresetValidationError("expectedRevision은 1 이상의 정수여야 합니다.", "expectedRevision");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PresetValidationError("preset 가져오기 payload는 객체여야 합니다.");
  }
  return value as Record<string, unknown>;
}

export class PresetService {
  constructor(private readonly repository: PresetRepository) {}

  initialize(): Promise<void> {
    return this.repository.initialize();
  }

  create(input: {
    ownerSubject: string;
    name: string;
    description?: string;
    config: unknown;
    tags?: string[];
    source?: PresetSource;
    now?: number;
  }): Promise<PortfolioPresetRecord> {
    return this.repository.create({
      ownerSubject: owner(input.ownerSubject),
      name: name(input.name),
      description: description(input.description),
      config: jsonSnapshot(input.config, "config"),
      tags: normalizedTags(input.tags),
      source: presetSource(input.source),
      now: input.now,
    });
  }

  get(id: string, ownerSubject: string): Promise<PortfolioPresetRecord | undefined> {
    return this.repository.get(id, owner(ownerSubject));
  }

  list(input: PortfolioPresetListInput): Promise<PortfolioPresetListResult> {
    return this.repository.list({
      ...input,
      ownerSubject: owner(input.ownerSubject),
      ...(input.search !== undefined ? { search: input.search.trim().slice(0, 200) } : {}),
      tags: normalizedTags(input.tags),
    });
  }

  update(input: {
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
    return this.repository.update({
      id: input.id,
      ownerSubject: owner(input.ownerSubject),
      expectedRevision: revision(input.expectedRevision),
      ...(input.name !== undefined ? { name: name(input.name) } : {}),
      ...(input.description !== undefined ? { description: description(input.description) } : {}),
      ...(input.config !== undefined ? { config: jsonSnapshot(input.config, "config") } : {}),
      ...(input.tags !== undefined ? { tags: normalizedTags(input.tags) } : {}),
      ...(input.source !== undefined ? { source: presetSource(input.source) } : {}),
      now: input.now,
    });
  }

  duplicate(input: {
    id: string;
    ownerSubject: string;
    name?: string;
    now?: number;
  }): Promise<PortfolioPresetRecord> {
    return this.repository.duplicate({
      id: input.id,
      ownerSubject: owner(input.ownerSubject),
      ...(input.name !== undefined ? { name: name(input.name) } : {}),
      now: input.now,
    });
  }

  delete(input: {
    id: string;
    ownerSubject: string;
    expectedRevision?: number;
    now?: number;
  }): Promise<boolean> {
    return this.repository.softDelete({
      id: input.id,
      ownerSubject: owner(input.ownerSubject),
      ...(input.expectedRevision !== undefined ? { expectedRevision: revision(input.expectedRevision) } : {}),
      now: input.now,
    });
  }

  markUsed(id: string, ownerSubject: string, now = Date.now()): Promise<PortfolioPresetRecord | undefined> {
    return this.repository.markUsed(id, owner(ownerSubject), now);
  }

  history(id: string, ownerSubject: string): Promise<PortfolioPresetVersionRecord[]> {
    return this.repository.getVersions(id, owner(ownerSubject));
  }

  async exportPreset(id: string, ownerSubject: string, now = Date.now()): Promise<PresetExport | undefined> {
    const stored = await this.repository.get(id, owner(ownerSubject));
    if (!stored) return undefined;
    return {
      schema_version: PRESET_EXPORT_SCHEMA_VERSION,
      exported_at: new Date(now).toISOString(),
      preset: {
        name: stored.name,
        description: stored.description,
        config: jsonSnapshot(stored.config, "config"),
        tags: [...stored.tags],
        source: presetSource(stored.source),
      },
    };
  }

  async importPreset(input: {
    ownerSubject: string;
    payload: string | unknown;
    name?: string;
    tags?: string[];
    now?: number;
  }): Promise<PortfolioPresetRecord> {
    let parsed: unknown;
    try {
      parsed = typeof input.payload === "string" ? JSON.parse(input.payload) as unknown : input.payload;
    } catch {
      throw new PresetValidationError("preset 가져오기 JSON을 해석할 수 없습니다.");
    }
    const root = asRecord(parsed);
    if (root.schema_version !== PRESET_EXPORT_SCHEMA_VERSION) {
      throw new PresetValidationError("지원하지 않는 preset export schema입니다.", "schema_version");
    }
    const imported = asRecord(root.preset);
    if (typeof imported.name !== "string" || typeof imported.description !== "string"
      || !Array.isArray(imported.tags)) {
      throw new PresetValidationError("preset export 필드가 올바르지 않습니다.");
    }
    const now = input.now ?? Date.now();
    return this.create({
      ownerSubject: input.ownerSubject,
      name: input.name ?? imported.name,
      description: imported.description,
      config: imported.config,
      tags: input.tags ?? imported.tags.filter((tag): tag is string => typeof tag === "string"),
      source: {
        type: "import",
        importedAt: new Date(now).toISOString(),
        originalSource: imported.source ?? { type: "unknown" },
      },
      now,
    });
  }
}
