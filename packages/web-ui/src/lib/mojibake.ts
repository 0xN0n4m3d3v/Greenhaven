const MOJIBAKE_MARKER = /[ÂÃÐÑØÙàáÎÕ×]/;

export function repairMojibakeText(value: string): string {
  if (!MOJIBAKE_MARKER.test(value)) return value;
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 255) return value;
    bytes.push(code);
  }
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return value;
  }
}

export function repairMojibakeRecord<T extends Record<string, string>>(
  record: T,
): T {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      repairMojibakeText(value),
    ]),
  ) as T;
}
