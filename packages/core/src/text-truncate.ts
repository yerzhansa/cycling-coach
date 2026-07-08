// `String.prototype.slice` counts UTF-16 code units, so a fixed-length cut can
// land between the two halves of a surrogate pair (emoji, some CJK), leaving a
// lone surrogate that renders as garbage and that some downstream APIs reject
// outright. Backing the cut off by one unit keeps the result well-formed.
export function truncateUtf16Safe(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const prev = text.charCodeAt(maxChars - 1);
  // maxChars === 1 with a leading high surrogate is unsalvageable — return the
  // lone unit rather than an empty string so callers always make progress.
  const cut = prev >= 0xd800 && prev <= 0xdbff && maxChars > 1 ? maxChars - 1 : maxChars;
  return text.slice(0, cut);
}
