import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMediaMcpServer } from "./server.js";

type Session = {
  server: ReturnType<typeof createMediaMcpServer>;
  transport: StreamableHTTPServerTransport;
};

const maxBodyBytes = 1024 * 1024;

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
    if (size > maxBodyBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? undefined : JSON.parse(raw);
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export async function startHttpServer() {
  const host = process.env.MEDIA_MCP_HTTP_HOST ?? "0.0.0.0";
  const port = Number(
    process.env.MEDIA_MCP_HTTP_PORT ?? process.env.PORT ?? 3000,
  );
  const sessions = new Map<string, Session>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        name: "media-mcp",
        transport: "streamable-http",
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
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Invalid or missing MCP session ID");
          return;
        }

        await session.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { allow: "GET, POST, DELETE" });
      res.end();
    } catch (error) {
      console.error("Error handling MCP HTTP request:", error);
      jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  console.error(
    `media-mcp Streamable HTTP listening on http://${host}:${port}/mcp`,
  );

  const shutdown = async () => {
    for (const session of sessions.values()) {
      await session.transport.close();
      await session.server.close();
    }
    httpServer.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
