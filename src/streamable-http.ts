import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { configuredApps } from "./config.js";
import { createMediaMcpServer } from "./server.js";

type Session = {
  server: ReturnType<typeof createMediaMcpServer>;
  transport: StreamableHTTPServerTransport;
};

const maxBodyBytes = 1024 * 1024;
const serverName = "media-mcp";
const serverVersion = "0.1.7";

class RequestBodyTooLargeError extends Error {}
class InvalidJsonBodyError extends Error {}

function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: string[],
) {
  const origin = firstHeader(req.headers.origin);
  const allowAny = allowedOrigins.includes("*");
  const allowedOrigin = allowAny
    ? "*"
    : origin && allowedOrigins.includes(origin)
      ? origin
      : undefined;

  if (origin && !allowedOrigin) {
    sendJson(res, 403, { error: "Origin is not allowed" });
    return false;
  }

  if (allowedOrigin) {
    res.setHeader("access-control-allow-origin", allowedOrigin);
    res.setHeader("vary", "Origin");
  }

  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, DELETE, OPTIONS",
  );
  res.setHeader(
    "access-control-allow-headers",
    [
      "authorization",
      "content-type",
      "last-event-id",
      "mcp-protocol-version",
      "mcp-session-id",
    ].join(", "),
  );
  res.setHeader(
    "access-control-expose-headers",
    "mcp-protocol-version, mcp-session-id",
  );
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
) {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonBodyError();
  }
}

function parsePort(value: string | undefined) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid MEDIA_MCP_HTTP_PORT/PORT: ${value}`);
  }
  return port;
}

export async function startHttpServer() {
  const host = process.env.MEDIA_MCP_HTTP_HOST ?? "0.0.0.0";
  const port = parsePort(
    process.env.MEDIA_MCP_HTTP_PORT ?? process.env.PORT ?? "3000",
  );
  const allowedOrigins = parseAllowedOrigins(
    process.env.MEDIA_MCP_ALLOWED_ORIGINS,
  );
  const sessions = new Map<string, Session>();

  const httpServer = createServer(async (req, res) => {
    if (!applyCors(req, res, allowedOrigins)) return;
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        name: serverName,
        version: serverVersion,
        transport: "streamable-http",
        endpoint: "/mcp",
        activeSessions: sessions.size,
        configuredApps: configuredApps(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        name: serverName,
        version: serverVersion,
        health: "/health",
        endpoint: "/mcp",
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const sessionId = firstHeader(req.headers["mcp-session-id"]);
        const existing = sessionId ? sessions.get(sessionId) : undefined;

        if (existing) {
          await existing.transport.handleRequest(req, res, body);
          return;
        }

        if (sessionId || !isInitializeRequest(body)) {
          jsonRpcError(
            res,
            400,
            -32000,
            "Bad Request: initialize first or provide a valid MCP session ID",
          );
          return;
        }

        let transport: StreamableHTTPServerTransport;
        const server = createMediaMcpServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { server, transport });
          },
        });
        transport.onclose = async () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) sessions.delete(closedSessionId);
          transport.onclose = undefined;
          await server.close();
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = firstHeader(req.headers["mcp-session-id"]);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) {
          sendJson(res, 400, { error: "Invalid or missing MCP session ID" });
          return;
        }

        await session.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { allow: "GET, POST, DELETE" });
      res.end();
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        jsonRpcError(res, 413, -32600, "Request body is too large");
        return;
      }
      if (error instanceof InvalidJsonBodyError) {
        jsonRpcError(res, 400, -32700, "Parse error: invalid JSON body");
        return;
      }
      console.error("Error handling MCP HTTP request:", error);
      jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  console.error(
    `${serverName} Streamable HTTP listening on http://${host}:${port}/mcp`,
  );

  const shutdown = async () => {
    for (const session of sessions.values()) {
      session.transport.onclose = undefined;
      await session.server.close();
    }
    httpServer.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
