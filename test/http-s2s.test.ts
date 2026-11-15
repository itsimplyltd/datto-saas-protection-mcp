// S2S v3 phase A, through a real HTTP server. The signers below are test
// helpers ported from cred-router (s2sHeader in index.js, s2sHeaderV3 in s2sV3.js).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createGatewayHttpServer, logS2sStartup, readMinVersion, resolveHttpS2sSecret,
  REQUIRE_SIGNED_HEADERS, S2S_AUDIENCE,
} from "../src/http.js";
import { DattoSaasApi } from "../src/datto-api.js";

const SECRET = "http-test-secret-0123456789abcdef0123456789";
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

// cred-router s2sHeader (legacy v1)
function legacyHeader(secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`t=${t}`).digest("hex")}`;
}

// cred-router s2sHeaderV3 (path is the rewritten /mcp; headers are lower-cased name -> value)
function v3Header(body: string, headers: Record<string, string> = {}, o: { aud?: string; method?: string } = {}): string {
  const t = Math.floor(Date.now() / 1000);
  const n = randomBytes(16).toString("hex");
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lines = [
    "ITSL-S2S-v3", `t=${t}`, `n=${n}`, `aud=${o.aud ?? S2S_AUDIENCE}`, `m=${o.method ?? "POST"}`, "p=/mcp",
    `b=${sha(body)}`, `sh=${names.join(";")}`, ...names.map((k) => `${k}:${sha(headers[k])}`),
  ];
  const v3 = createHmac("sha256", SECRET).update(lines.join("\n"), "utf8").digest("hex");
  return `t=${t},n=${n},sh=${names.join(";")},v3=${v3}`;
}

const CREDS = { "x-datto-saas-public-key": "pub-key-1", "x-datto-saas-secret-key": "sec-key-1" };
const INIT = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as AddressInfo).port;
}

async function start(minVersion = 1, isGatewayMode = true) {
  const logs: { level: string; msg: string; meta?: Record<string, unknown> }[] = [];
  const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => logs.push({ level: "info", msg, meta }),
    warn: (msg: string, meta?: Record<string, unknown>) => logs.push({ level: "warn", msg, meta }),
    error: (msg: string, meta?: Record<string, unknown>) => logs.push({ level: "error", msg, meta }),
  };
  const port = await listen(createGatewayHttpServer({ secret: SECRET, minVersion, isGatewayMode, logger }));
  return { port, logs };
}

function send(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const rq = httpRequest({ host: "127.0.0.1", port, method: o.method ?? "POST", path: o.path ?? "/mcp", headers: o.headers, agent: false }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    rq.on("error", reject);
    rq.end(o.body ?? "");
  });
}

const call = (port: number, s2s: string, extra: Record<string, string> = CREDS, body = INIT) =>
  send(port, { headers: { ...MCP_HEADERS, ...extra, "x-gateway-s2s": s2s }, body });

describe("S2S v3 phase A over HTTP", () => {
  it("accepts a legacy v1 header at the floor", async () => {
    const { port } = await start(1);
    expect((await call(port, legacyHeader())).status).toBe(200);
  });

  it("refuses a legacy header signed with the wrong secret", async () => {
    const { port } = await start(1);
    expect((await call(port, legacyHeader("x".repeat(40)))).status).toBe(401);
  });

  it("accepts v3 with the credential headers signed", async () => {
    const { port } = await start(1);
    expect((await call(port, v3Header(INIT, CREDS))).status).toBe(200);
  });

  it("refuses a replayed v3 header", async () => {
    const { port } = await start(1);
    const h = v3Header(INIT, CREDS);
    expect((await call(port, h)).status).toBe(200);
    expect((await call(port, h)).status).toBe(401);
  });

  it("refuses v3 for the wrong audience", async () => {
    const { port } = await start(1);
    expect((await call(port, v3Header(INIT, CREDS, { aud: "datto-bcdr" }))).status).toBe(401);
  });

  for (const mode of [1, 3]) {
    for (const name of REQUIRE_SIGNED_HEADERS) {
      it(`v3 with ${name} present but unsigned is refused (min ${mode}, ${mode === 1 ? "report" : "enforce"} mode)`, async () => {
        const { port } = await start(mode);
        const signed: Record<string, string> = { ...CREDS };
        delete signed[name];
        const r = await call(port, v3Header(INIT, signed));
        expect(r.status).toBe(401);
      });
    }
  }

  it("refuses legacy at min 3, accepts v3", async () => {
    const { port } = await start(3);
    expect((await call(port, legacyHeader())).status).toBe(401);
    expect((await call(port, v3Header(INIT, CREDS))).status).toBe(200);
  });

  it("refuses a request with no S2S header", async () => {
    const { port } = await start(1);
    expect((await send(port, { headers: { ...MCP_HEADERS, ...CREDS }, body: INIT })).status).toBe(401);
  });

  it("keeps gateway-mode behaviour: missing credentials are a 401, GET is a 405", async () => {
    const { port } = await start(1);
    const noCreds = await call(port, legacyHeader(), {});
    expect(noCreds.status).toBe(401);
    expect(noCreds.body).toContain("Missing credentials");
    const get = await send(port, { method: "GET", headers: { "x-gateway-s2s": v3Header("", CREDS, { method: "GET" }), ...CREDS } });
    expect(get.status).toBe(405);
  });

  it("an aborted upload does not crash the server (health still answers)", async () => {
    const { port } = await start(1);
    const sock = connect(port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nX-Gateway-S2S: ${legacyHeader()}\r\nContent-Length: 1000\r\n\r\n0123456789`);
    await new Promise((r) => setTimeout(r, 100));
    sock.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const h = await send(port, { method: "GET", path: "/health" });
    expect(h.status).toBe(200);
    expect(JSON.parse(h.body).status).toBe("ok");
  });

  it("answers /health without auth and returns 404 for unknown paths before auth", async () => {
    const { port } = await start(1);
    expect((await send(port, { method: "GET", path: "/health" })).status).toBe(200);
    for (const path of ["/", "/mcp/", "/admin", "/healthz"]) {
      expect((await send(port, { method: "POST", path, body: "{}" })).status).toBe(404);
    }
  });
});

describe("start-up", () => {
  it("logs the effective min version and header-rule mode", () => {
    for (const [min, eff, mode] of [[1, 1, "report"], [3, 3, "enforced"], [NaN, 3, "enforced"]] as const) {
      const info = vi.fn();
      logS2sStartup(min, { info, warn: vi.fn(), error: vi.fn() });
      expect(info).toHaveBeenCalledWith("S2S v3 configuration", { effectiveMinVersion: eff, headerRule: mode });
    }
  });

  it("the start-up log line is written to stderr by the default logger", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logS2sStartup(1);
    const line = String(spy.mock.calls[0][0]);
    spy.mockRestore();
    expect(JSON.parse(line)).toMatchObject({ level: "info", msg: "S2S v3 configuration", effectiveMinVersion: 1, headerRule: "report" });
  });

  it("refuses to start without a secret of at least 32 characters", () => {
    expect(() => resolveHttpS2sSecret({})).toThrow(/at least 32/);
    expect(() => resolveHttpS2sSecret({ CONDUIT_S2S_SECRET: "short" })).toThrow(/at least 32/);
    expect(resolveHttpS2sSecret({ CONDUIT_S2S_SECRET: SECRET })).toBe(SECRET);
    try {
      resolveHttpS2sSecret({ CONDUIT_S2S_SECRET: "short" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("short");
    }
  });

  it("ITSL_S2S_MIN_VERSION defaults to the floor of 1", () => {
    expect(readMinVersion({})).toBe(1);
    expect(readMinVersion({ ITSL_S2S_MIN_VERSION: "3" })).toBe(3);
  });
});

describe("vendor redirects fail closed", () => {
  it("a 3xx from the vendor is an error and the Location is never followed", async () => {
    let followed = 0;
    const other = createServer((_req, res) => {
      followed++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });
    const otherPort = await listen(other);
    const vendor = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/stolen` });
      res.end();
    });
    const vendorPort = await listen(vendor);
    const api = new DattoSaasApi({ publicKey: "pk", secretKey: "sk", baseUrl: `http://127.0.0.1:${vendorPort}` });
    await expect(api.listDomains()).rejects.toThrow();
    expect(followed).toBe(0);
  });
});
