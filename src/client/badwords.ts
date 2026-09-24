import { Filter } from "bad-words";

// Shared profanity check for user-supplied on-chain text: asset names/symbols
// and peer node tags. The blocklist ships with the `bad-words` package; the
// site can extend it with `filter.addWords(...)` and suppress false positives
// with `filter.removeWords(...)`.
const filter = new Filter();

export function containsBadWord(text: unknown): boolean {
  const value = String(text ?? "").trim();
  if (!value) return false;
  try {
    return filter.isProfane(value);
  } catch {
    return false;
  }
}