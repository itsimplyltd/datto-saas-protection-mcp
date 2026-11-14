#!/usr/bin/env node
/**
 * Datto SaaS Protection MCP Server
 *
 * This MCP server provides tools for interacting with the Datto SaaS
 * Protection (Backupify) API. It accepts credentials via environment
 * variables (env mode) or per-request HTTP headers (gateway mode).
 *
 * Supports both stdio (default) and HTTP (StreamableHTTP) transports.
 * The server factory itself lives in mcp-server.ts (side-effect free, so
 * tests can drive it directly); this entrypoint only wires up transports.
 */

import { type Server as HttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import { bindServerRef } from "./utils/server-ref.js";
import { createGatewayHttpServer, logS2sStartup, readMinVersion, resolveHttpS2sSecret } from "./http.js";

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  // stdio is single-session for the whole process — no concurrent tenants
  // to isolate from each other, so enterWith's process-lifetime binding is
  // safe.
  bindServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Datto SaaS Protection MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  // HTTP mode refuses to start without a real S2S secret (>= 32 characters).
  let secret: string;
  try {
    secret = resolveHttpS2sSecret();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const minVersion = readMinVersion();

  httpServer = createGatewayHttpServer({ secret, minVersion, isGatewayMode });

  await new Promise<void>((resolve) => {
    httpServer!.listen(port, host, () => {
      console.error(`Datto SaaS Protection MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      logS2sStartup(minVersion);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down Datto SaaS Protection MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandlers();

  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

main().catch(console.error);
