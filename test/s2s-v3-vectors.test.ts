// Port of MCP-Gateway s2s/s2s-v3.test.ts (node:test) to vitest. Runs the shared
// vectors through the vendored verifier, src/itsl/s2s-v3.ts, which must stay
// byte-identical to the canonical copy.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  NonceCache, RawBodyError, readRawBody, verifyV3, checkGatewayRequest, canonicalV3, parseV3Header,
  INGRESS_EXEMPT_HEADERS, assertRequireSignedHeaders, stripExemptHeaders, formatUnsignedHeaderReport,
  ReportRateLimiter, effectiveMinVersion,
} from "../src/itsl/s2s-v3.js";

const CANONICAL_SHA256 = "3160ee243febcf990c4eb84f514c254a7d9a98592fa1d9b53888f1ad0dde11b0";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const vectors: Any = JSON.parse(readFileSync(new URL("./fixtures/s2s-v3-vectors.json", import.meta.url), "utf8"));
const secret: string = vectors.secret;

function args(c: Any, cache: NonceCache) {
  return {
    method: c.method, rawTarget: c.rawTarget, body: Buffer.from(c.body, "utf8"), rawHeaders: c.rawHeaders,
    secret: c.secretOverride ?? secret, aud: c.aud, nowSeconds: c.nowSeconds, nonceCache: cache,
    headerRuleMode: c.headerRuleMode,
  };
}

describe("vendored s2s-v3.ts", () => {
  it("is byte-identical to the canonical copy (sha256 pin)", () => {
    const bytes = readFileSync(new URL("../src/itsl/s2s-v3.ts", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(CANONICAL_SHA256);
  });
});

describe("shared vectors", () => {
  for (const c of vectors.positive) {
    it(`positive: ${c.name}`, () => {
      expect(verifyV3(args(c, new NonceCache()))).toEqual({ ok: true, version: 3 });
    });
    if (!c.derivedFrom) {
      it(`positive canonical string is pinned: ${c.name}`, () => {
        const parsed = parseV3Header(c.header)!;
        const headerHashes: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.signedHeaders)) headerHashes[k] = createHash("sha256").update(v as string).digest("hex");
        const canonical = canonicalV3({
          t: parsed.tRaw, n: parsed.n, aud: c.aud, method: c.method, path: c.rawTarget,
          bodySha256: createHash("sha256").update(c.body).digest("hex"), sh: parsed.sh, headerHashes,
        });
        expect(canonical).toBe(c.canonical);
      });
    }
  }

  for (const c of vectors.negative) {
    it(`negative: ${c.name} -> ${c.expect}`, () => {
      const cache = new NonceCache();
      if (c.replayOf) {
        const first = vectors.positive.find((p: Any) => p.name === c.replayOf);
        expect(verifyV3(args(first, cache)).ok).toBe(true);
      }
      expect(verifyV3(args(c, cache))).toEqual({ ok: false, reason: c.expect });
    });
  }

  for (const c of vectors.check) {
    it(`checkGatewayRequest: ${c.name}`, () => {
      const r: Any = checkGatewayRequest({
        ...args(c, new NonceCache()), floor: c.floor, minVersion: c.minVersion,
        verifyLegacy: () => c.legacyResult ?? 0,
      });
      expect(r.ok).toBe(c.expect.ok);
      expect(r.version).toBe(c.expect.version);
      if (!c.expect.ok) expect(r.reason).toBe(c.expect.reason);
      expect(r.unsignedHeaderNames).toEqual(c.expect.unsignedHeaderNames);
    });
  }

  for (const c of vectors.readRawBody) {
    it(`readRawBody: ${c.name}`, async () => {
      const req = Object.assign(Readable.from([Buffer.from(c.body)]), { headers: c.headers }) as unknown as IncomingMessage;
      if (c.expectStatus) {
        await expect(readRawBody(req)).rejects.toSatisfy((e: Any) => e instanceof RawBodyError && e.status === c.expectStatus);
      } else {
        expect((await readRawBody(req)).toString()).toBe(c.body);
      }
    });
  }

  for (const c of vectors.requireSigned) {
    it(`requireSigned: ${c.name}`, () => {
      const base = vectors.positive.find((p: Any) => p.name === c.from);
      const rawHeaders = [...base.rawHeaders, ...(c.extraRawHeaders ?? [])];
      const r: Any = verifyV3({ ...args(base, new NonceCache()), rawHeaders, headerRuleMode: c.headerRuleMode, requireSignedHeaders: c.requireSignedHeaders });
      expect(r.ok).toBe(c.expect.ok);
      if (!r.ok) expect(r.reason).toBe(c.expect.reason);
    });
  }

  it("requireSigned: invalid or exempt names throw at configuration time", () => {
    for (const list of vectors.requireSignedConfigErrors) expect(() => assertRequireSignedHeaders(list)).toThrow(/requireSignedHeaders/);
    expect(() => assertRequireSignedHeaders(["x-mcp-tier", "x-user-token"])).not.toThrow();
  });
});

describe("verifier behaviour", () => {
  it("records the nonce only after the HMAC verifies", () => {
    const cache = new NonceCache();
    const c = vectors.positive[1];
    expect(verifyV3(args({ ...c, body: c.body + " " }, cache)).ok).toBe(false);
    expect(cache.entries.size).toBe(0);
    expect(verifyV3(args(c, cache)).ok).toBe(true);
    expect(cache.entries.size).toBe(1);
  });

  it("a nonce lives until its own t + 35", () => {
    const cache = new NonceCache();
    const n = "0".repeat(32);
    cache.add(n, 1000, 1000);
    expect(cache.has(n, 1034)).toBe(true);
    expect(cache.has(n, 1035)).toBe(false);
  });

  it("a full nonce cache fails closed", () => {
    const cache = new NonceCache(2);
    const c = vectors.positive[0];
    cache.add("a".repeat(32), c.t, c.t);
    cache.add("b".repeat(32), c.t, c.t);
    expect(verifyV3(args(c, cache))).toEqual({ ok: false, reason: "nonce-cache-full" });
  });

  it("the wrong secret never verifies", () => {
    expect(verifyV3({ ...args(vectors.positive[0], new NonceCache()), secret: "vector-s2s-anothersecret0123456789abcdef" })).toEqual({ ok: false, reason: "hmac" });
  });

  it("every exempt name is refused inside requireSignedHeaders", () => {
    for (const name of INGRESS_EXEMPT_HEADERS) expect(() => assertRequireSignedHeaders([name])).toThrow();
  });

  it("stripExemptHeaders removes only exempt names, in place", () => {
    const req = {
      headers: { host: "h", "x-request-id": "a", "x-keep": "k" } as Record<string, unknown>,
      rawHeaders: ["Host", "h", "X-Request-Id", "a", "X-Keep", "k"],
    };
    stripExemptHeaders(req);
    expect(req.headers).toEqual({ host: "h", "x-keep": "k" });
    expect(req.rawHeaders).toEqual(["Host", "h", "X-Keep", "k"]);
  });

  it("formatUnsignedHeaderReport sanitises names", () => {
    expect(formatUnsignedHeaderReport(["X-Foo", "x-bar"])).toEqual(["x-bar", "x-foo"]);
    expect(formatUnsignedHeaderReport(["x-a b"])).toEqual(["invalid-name"]);
  });

  it("ReportRateLimiter emits once per name-set per window", () => {
    const l = new ReportRateLimiter(3, 60);
    expect(l.shouldEmit(["b", "a"], 100)).toBe(true);
    expect(l.shouldEmit(["a", "b"], 120)).toBe(false);
    expect(l.shouldEmit(["a", "b"], 160)).toBe(true);
  });

  it("effectiveMinVersion: max(floor, min), invalid counts as 3", () => {
    expect(effectiveMinVersion(1, 1)).toBe(1);
    expect(effectiveMinVersion(1, 3)).toBe(3);
    expect(effectiveMinVersion(1, NaN)).toBe(3);
  });
});
