/**
 * HTTP (StreamableHTTP) transport for the Datto SaaS Protection MCP server.
 *
 * Every /mcp request goes through handleGatewayRequest (S2S v3 phase A): the
 * gateway's request-bound v3 signature is accepted alongside the legacy v1
 * header. ITSL_S2S_MIN_VERSION (default 1, the floor) tightens that; at 3 only
 * v3 is accepted and the unsigned-header rule is enforced.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type DattoSaasCredentials } from "./credentials.js";
import { createMcpServer } from "./mcp-server.js";
import { runWithServerRef } from "./utils/server-ref.js";
import { verifyS2sHeader } from "./s2s-verify.js";
import { logger as defaultLogger, type Logger } from "./utils/logger.js";
import {
  NonceCache,
  ReportRateLimiter,
  assertRequireSignedHeaders,
  effectiveMinVersion,
  handleGatewayRequest,
} from "./itsl/s2s-v3.js";

/** Audience cred-router signs for this vendor (finishSignedProxyRequest vendor: 'datto-saas'). */
export const S2S_AUDIENCE = "datto-saas";

/** The legacy version this backend enforces today: v1 only (s2s-verify.ts). */
export const S2S_FLOOR = 1;

export const MIN_S2S_SECRET_LENGTH = 32;

/**
 * Headers this backend reads as credentials, all set by cred-router on the
 * proxied request. Present-but-unsigned fails a v3 request in report mode too.
 */
export const REQUIRE_SIGNED_HEADERS = ["x-datto-saas-public-key", "x-datto-saas-secret-key"];
assertRequireSignedHeaders(REQUIRE_SIGNED_HEADERS);

/** One per process: v3 nonces are single-use inside the skew window. */
const nonceCache = new NonceCache();
const reportLimiter = new ReportRateLimiter();
const failureLimiter = new ReportRateLimiter();

/**
 * HTTP mode refuses to start without a real S2S secret. Throws with a message
 * that never contains the secret or its length.
 */
export function resolveHttpS2sSecret(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CONDUIT_S2S_SECRET || "";
  if (raw.length < MIN_S2S_SECRET_LENGTH) {
    throw new Error(
      `Refusing to start HTTP server: CONDUIT_S2S_SECRET must be set to at least ${MIN_S2S_SECRET_LENGTH} characters (openssl rand -hex 32).`
    );
  }
  return raw;
}

/**
 * Operator switch for the S2S v3 rollout. Passed through raw: anything that is
 * not an integer 1..3 is treated as 3 by the verifier (a typo can only tighten).
 */
export function readMinVersion(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.ITSL_S2S_MIN_VERSION ?? String(S2S_FLOOR));
}

/** Boot log required by the security reviewer: effective minimum and header rule mode. */
export function logS2sStartup(minVersion: number, logger: Logger = defaultLogger): void {
  const effective = effectiveMinVersion(S2S_FLOOR, minVersion);
  logger.info("S2S v3 configuration", {
    effectiveMinVersion: effective,
    headerRule: effective === 3 ? "enforced" : "report",
  });
}

export interface GatewayHttpOptions {
  secret: string;
  minVersion: number;
  isGatewayMode: boolean;
  logger?: Logger;
}

export function createGatewayHttpServer(opts: GatewayHttpOptions): HttpServer {
  const { secret, minVersion, isGatewayMode } = opts;
  const logger = opts.logger ?? defaultLogger;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Raw target, not a parsed URL: the signed path is exactly what was sent.
    const rawTarget = req.url ?? "/";
    const queryAt = rawTarget.indexOf("?");
    const pathname = queryAt === -1 ? rawTarget : rawTarget.slice(0, queryAt);

    // Health endpoint - no auth required
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
      return;
    }

    // The shared wrapper runs the S2S check first (before method checks or
    // credential extraction), reads the body once, and never rejects.
    await handleGatewayRequest(
      req,
      res,
      {
        secret,
        aud: S2S_AUDIENCE,
        floor: S2S_FLOOR,
        minVersion,
        verifyLegacy: (headerValue) => (verifyS2sHeader(headerValue, secret) ? 1 : 0),
        nonceCache,
        reportLimiter,
        failureLimiter,
        logger,
        requireSignedHeaders: REQUIRE_SIGNED_HEADERS,
      },
      async ({ parsedBody }) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Method not allowed" },
              id: null,
            })
          );
          return;
        }

        // In gateway mode, extract credentials from headers and pass directly
        // to avoid process.env race conditions under concurrent load.
        let gatewayCredentials: DattoSaasCredentials | undefined;
        if (isGatewayMode) {
          const headers = req.headers as Record<string, string | string[] | undefined>;
          const publicKey = headers["x-datto-saas-public-key"] as string | undefined;
          const secretKey = headers["x-datto-saas-secret-key"] as string | undefined;
          // No region header: Datto SaaS Protection has a single API host
          // (api.datto.com). X-Datto-SaaS-Region, if still sent, is ignored.

          if (!publicKey || !secretKey) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Missing credentials",
                message:
                  "Gateway mode requires X-Datto-SaaS-Public-Key and X-Datto-SaaS-Secret-Key headers",
                required: ["X-Datto-SaaS-Public-Key", "X-Datto-SaaS-Secret-Key"],
              })
            );
            return;
          }

          gatewayCredentials = { publicKey, secretKey };
        }

        // Stateless: fresh server + transport per request
        const server = createMcpServer(gatewayCredentials);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on("close", () => {
          transport.close();
          server.close();
        });

        // The whole chain below (connect through the catch handler) runs
        // inside runWithServerRef so the server-ref binding (used by
        // elicitation) survives every await gap in this request's lifecycle
        // without leaking into a concurrent request's server-ref. The body
        // was already read (and hashed) by the S2S wrapper, so the transport
        // is handed the parsed body instead of re-reading the stream.
        await runWithServerRef(server, () =>
          server
            .connect(transport as unknown as Transport)
            .then(() => transport.handleRequest(req, res, parsedBody))
            .catch((err) => {
              console.error("MCP transport error:", err);
              if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal error" },
                    id: null,
                  })
                );
              }
            })
        );
      }
    );
  });
}
