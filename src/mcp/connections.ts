import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import crypto from "node:crypto";

export const connectionsBySessionId: Record<
  string,
  {
    transport: SSEServerTransport | StdioServerTransport | StreamableHTTPServerTransport;
    sellerToken: string;
  }
> = {};

export const globalSessionId = crypto.randomUUID();
