import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import crypto from "node:crypto";

export const connectionsBySessionId: Record<
  string,
  {
    transport: SSEServerTransport | StdioServerTransport | StreamableHTTPServerTransport;
    sellerToken: string;
    accessToken?: string; // MCP bearer token — stored so tools can revoke it on SR 401
  }
> = {};

export const globalSessionId = crypto.randomUUID();

// Sessions where Shiprocket returned 401 — MCP tokens are revoked on the next HTTP request
// to force a full OAuth re-auth (login form) rather than a silent token refresh
export const expiredSellerTokenSessions = new Set<string>();
