#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMediaMcpServer } from "./server.js";
import { startHttpServer } from "./streamable-http.js";

const transport = (process.env.MEDIA_MCP_TRANSPORT ?? "stdio").toLowerCase();

if (transport === "http" || transport === "streamable-http") {
  await startHttpServer();
} else {
  await createMediaMcpServer().connect(new StdioServerTransport());
}
