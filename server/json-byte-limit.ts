type SizeCounter = {
  bytes: number;
  threshold: number;
  ancestors: WeakSet<object>;
};

type JsonPath = Array<string | number>;

function jsonPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (result, segment) => typeof segment === "number"
      ? `${result}[${segment}]`
      : `${result}.${segment}`,
    "$",
  );
}

function addBytes(counter: SizeCounter, byteCount: number): boolean {
  counter.bytes += byteCount;
  return counter.bytes >= counter.threshold;
}

function countJsonString(value: string, counter: SizeCounter): boolean {
  if (addBytes(counter, 2)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      if (addBytes(counter, 2)) return true;
      continue;
    }
    if (code < 0x20) {
      const escapedBytes = code === 0x08
        || code === 0x09
        || code === 0x0a
        || code === 0x0c
        || code === 0x0d
        ? 2
        : 6;
      if (addBytes(counter, escapedBytes)) return true;
      continue;
    }
    if (code < 0x80) {
      if (addBytes(counter, 1)) return true;
      continue;
    }
    if (code < 0x800) {
      if (addBytes(counter, 2)) return true;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        if (addBytes(counter, 4)) return true;
      } else if (addBytes(counter, 6)) {
        return true;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      if (addBytes(counter, 6)) return true;
      continue;
    }
    if (addBytes(counter, 3)) return true;
  }
  return false;
}

function countCanonicalJson(value: unknown, counter: SizeCounter, path: JsonPath = []): boolean {
  if (value === null) return addBytes(counter, 4);
  if (typeof value === "string") return countJsonString(value, counter);
  if (typeof value === "boolean") return addBytes(counter, value ? 4 : 5);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`worker payload의 ${jsonPath(path)} 값은 유한한 숫자여야 합니다.`);
    return addBytes(counter, String(Object.is(value, -0) ? 0 : value).length);
  }
  if (Array.isArray(value)) {
    if (counter.ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
    counter.ancestors.add(value);
    try {
      if (addBytes(counter, 1)) return true;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && addBytes(counter, 1)) return true;
        if (!(index in value)) {
          if (addBytes(counter, 4)) return true;
          continue;
        }
        path.push(index);
        const exceeds = countCanonicalJson(value[index], counter, path);
        path.pop();
        if (exceeds) return true;
      }
      return addBytes(counter, 1);
    } finally {
      counter.ancestors.delete(value);
    }
  }
  if (value instanceof Map) {
    if (counter.ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
    counter.ancestors.add(value);
    try {
      const normalized = new Map<string, unknown>();
      for (const [key, item] of value.entries()) normalized.set(String(key), item);
      if (addBytes(counter, 1)) return true;
      let index = 0;
      for (const [key, item] of normalized) {
        if (index > 0 && addBytes(counter, 1)) return true;
        if (countJsonString(key, counter) || addBytes(counter, 1)) return true;
        path.push(key);
        const exceeds = countCanonicalJson(item, counter, path);
        path.pop();
        if (exceeds) return true;
        index += 1;
      }
      return addBytes(counter, 1);
    } finally {
      counter.ancestors.delete(value);
    }
  }
  if (typeof value === "object" && value) {
    if (counter.ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
    counter.ancestors.add(value);
    try {
      const record = value as Record<string, unknown>;
      if (addBytes(counter, 1)) return true;
      let index = 0;
      for (const key of Object.keys(record)) {
        const item = record[key];
        if (item === undefined) continue;
        if (index > 0 && addBytes(counter, 1)) return true;
        if (countJsonString(key, counter) || addBytes(counter, 1)) return true;
        path.push(key);
        const exceeds = countCanonicalJson(item, counter, path);
        path.pop();
        if (exceeds) return true;
        index += 1;
      }
      return addBytes(counter, 1);
    } finally {
      counter.ancestors.delete(value);
    }
  }
  throw new Error(`worker payload의 ${jsonPath(path)} 값은 JSON으로 직렬화할 수 없습니다.`);
}

export function canonicalJsonExceedsByteLimit(value: unknown, maximumBytes: number): boolean {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes === Number.MAX_SAFE_INTEGER) {
    throw new Error("canonical JSON byte limit must be a non-negative safe integer below MAX_SAFE_INTEGER");
  }
  return countCanonicalJson(value, {
    bytes: 0,
    threshold: maximumBytes + 1,
    ancestors: new WeakSet(),
  });
}
