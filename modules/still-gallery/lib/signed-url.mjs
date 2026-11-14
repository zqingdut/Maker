/**
 * Expiry of a signed object-storage URL.
 *
 * Kept in one place on purpose. This project previously had two copies of this
 * logic — one in `log-parser.mjs` (correct) and one in `image-gen.mjs` (wrong) —
 * and they disagreed about what `X-Tos-Expires` means.
 *
 * TOS signs with `X-Tos-Date=<YYYYMMDD>T<HHMMSS>Z` plus `X-Tos-Expires=<seconds>`,
 * where the second value is a **lifetime**, not a timestamp. Reading it as epoch
 * seconds turns Ark's 86400 into 1970-01-02, which made every freshly generated
 * image claim it had already expired.
 */

/** Parse the compact `YYYYMMDDTHHMMSSZ` stamp TOS puts in `X-Tos-Date`. */
export function parseTosDate(raw) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(raw || '').trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Derive the expiry of a signed URL, or null when it cannot be established.
 *
 * Returning null is deliberate: an unplaceable lifetime must not be reported as
 * a date, because the UI turns a past expiry into a "this link is dead" warning.
 */
export function extractUrlExpiry(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return null;
  }

  const stamp = url.searchParams.get('X-Tos-Expires');
  if (!stamp) return null;
  const value = Number(stamp);
  if (!Number.isFinite(value) || value <= 0) return null;

  // Normal case: a lifetime, anchored on the signing timestamp.
  const signed = parseTosDate(url.searchParams.get('X-Tos-Date'));
  if (signed) return new Date(signed.getTime() + value * 1000).toISOString();

  // Some endpoints emit an absolute epoch instead, with no anchor header. Only
  // accept values that are plausible epoch seconds; anything smaller is a
  // lifetime we cannot place on the calendar.
  if (value < 1e9) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
