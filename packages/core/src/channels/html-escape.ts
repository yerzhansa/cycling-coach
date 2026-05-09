/**
 * HTML escape helpers for Telegram message HTML.
 *
 * `escapeHtmlText` escapes only the three chars Telegram requires inside
 * element bodies (`&<>`). Use this for `<pre>` and `<code>` block content
 * where `"` and `'` are literal text and don't need encoding.
 *
 * `escapeHtmlAttr` additionally escapes `"` and `'` for defense-in-depth in
 * attribute-like contexts (and arbitrary user-supplied strings interpolated
 * into surrounding markup).
 */

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeHtmlAttr(s: string): string {
  return escapeHtmlText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
