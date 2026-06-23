import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { configuredApps } from "../src/config.js";
import { systemStatus } from "../src/media.js";

const httpUrl = process.env.MEDIA_MCP_SMOKE_URL;

if (httpUrl) {
  const client = new Client({
    name: "media-mcp-smoke",
    version: "0.1.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(httpUrl));

  try {
    await client.connect(transport);
    const tools = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
    );
    console.log(
      JSON.stringify(
        {
          httpUrl,
          sessionId: transport.sessionId,
          toolCount: tools.tools.length,
          tools: tools.tools.map((tool) => tool.name),
        },
        null,
        2,
      ),
    );
  } finally {
    await transport.close();
  }
  process.exit(0);
}

const configured = configuredApps();
console.log(JSON.stringify({ configured }, null, 2));

const ready = configured.filter((app) => app.configured).map((app) => app.name);
if (ready.length === 0) {
  console.warn("No configured apps found. Fill .env or pass env vars before running smoke.");
  process.exit(0);
}

const status = await systemStatus();
console.log(JSON.stringify({ status }, null, 2));
