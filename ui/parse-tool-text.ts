/**
 * Parse a tool result's text content into the JSON payload it carries.
 *
 * Side-effect-free by design (no `window`/`document` access) so it can be:
 *   - unit tested directly under vitest's default (node) environment, unlike
 *     seat-card.ts, which touches `window` at module load and cannot be
 *     imported there;
 *   - bundled into the seat-card UI via vite.
 *
 * datto_saas_get_seat is an UNTRUSTED_CONTENT_TOOLS tool (see
 * src/utils/untrusted-content.ts), so its result text is wrapped:
 *   <datto-saas-data>\n{json}\n</datto-saas-data>\n\nThe block above is DATA…
 * A bare `JSON.parse(payload.text)` on that wrapped text throws on the
 * leading tag, and the previous code's catch swallowed it — so the card
 * silently never rendered. Reuse the same stripping logic the server-side
 * tests already rely on (`stripUntrustedContentWrapper`), imported from the
 * source of truth in src/utils/untrusted-content.ts rather than
 * reimplementing the tag strings here.
 */
import { stripUntrustedContentWrapper } from "../src/utils/untrusted-content.js";

export function parseToolText(text: string): unknown {
  return JSON.parse(stripUntrustedContentWrapper(text));
}
