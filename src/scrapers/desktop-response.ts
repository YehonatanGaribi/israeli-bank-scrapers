/** Format compatibility, never financial inference. All decoded values stay in
 * the confined collector; callers expose only validated records/type summaries. */
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const key = (value: string) => value.toLowerCase().replace(/[_-]/g, '');
export function field(value: unknown, ...names: string[]): unknown {
  if (!record(value)) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
    const matches = Object.keys(value).filter(item => key(item) === key(name));
    if (matches.length === 1) return value[matches[0]];
  }
  return undefined;
}
export function decode(input: unknown): unknown {
  let value = input;
  for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) {
    if (value.length > 2_000_000) throw new Error('BANK_RESPONSE_TOO_LARGE');
    const text = value.trim();
    if (!/^[\[{\"]/.test(text)) break;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      break;
    }
  }
  return value;
}
export function flag(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return undefined;
  if (['true', '1', 'ok', 'success'].includes(value.trim().toLowerCase())) return true;
  if (['false', '0', 'failed', 'failure', 'error'].includes(value.trim().toLowerCase())) return false;
  return undefined;
}
export function neutralCode(value: unknown): boolean {
  return value == null || value === false || value === 0 || value === '' || value === '0';
}
/** Recognize a payload by its data, not one exact success/error wrapper. Walk
 * bounded object wrappers, including encoded JSON; ambiguous payloads fail. */
export function payload(value: unknown, matches: (item: unknown) => boolean): unknown {
  let queue: Array<{ value: unknown; denied: boolean }> = [{ value, denied: false }];
  let visited = 0;
  for (let depth = 0; depth < 6 && queue.length; depth++) {
    const next: typeof queue = [],
      found: unknown[] = [];
    for (const entry of queue) {
      if (++visited > 64) throw new Error('BANK_RESPONSE_TOO_COMPLEX');
      const item = decode(entry.value);
      const denied = entry.denied || flag(field(item, 'isSuccess', 'success')) === false;
      if (matches(item)) {
        if (denied) throw new Error('BANK_APPLICATION_REJECTED');
        found.push(item);
        continue;
      }
      if (!record(item)) continue;
      const entries = Object.entries(item);
      entries.sort(
        ([a], [b]) =>
          Number(!['data', 'result', 'response', 'body', 'payload', 'd'].includes(key(a))) -
          Number(!['data', 'result', 'response', 'body', 'payload', 'd'].includes(key(b))),
      );
      for (const [, child] of entries)
        if (record(child) || Array.isArray(child) || (typeof child === 'string' && /^[\s]*[\[{\"]/.test(child)))
          next.push({ value: child, denied });
    }
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error('BANK_RESPONSE_AMBIGUOUS');
    queue = next;
  }
  throw new Error('BANK_PAYLOAD_UNRECOGNIZED');
}
export function integer(value: unknown): number | undefined {
  const result = typeof value === 'string' && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof result === 'number' && Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}
export function suffix(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999)
    return String(value).padStart(4, '0');
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d{4}$/.test(text)) return text;
  return /^[*•xX -]+\d{4}$/.test(text) ? text.slice(-4) : undefined;
}
