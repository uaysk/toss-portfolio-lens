function rawKeyCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`worker payload의 ${path} 값은 유한한 숫자여야 합니다.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries())
        .map(([key, item]) => [String(key), canonicalValue(item, `${path}.${String(key)}`)] as const)
        .sort(([left], [right]) => rawKeyCompare(left, right)),
    );
  }
  if (typeof value === "object" && value) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => rawKeyCompare(left, right))
      .map(([key, item]) => [key, canonicalValue(item, `${path}.${key}`)] as const);
    return Object.fromEntries(entries);
  }
  throw new Error(`worker payload의 ${path} 값은 JSON으로 직렬화할 수 없습니다.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
