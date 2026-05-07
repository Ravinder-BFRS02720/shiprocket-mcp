import express, { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import axios from "axios";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "@/mcp/index";
import { connectionsBySessionId } from "@/mcp/connections";
import { API_DOMAINS } from "@/config";
import "dotenv/config";

const PORT = parseInt(process.env.APP_PORT ?? "3000", 10);

async function startHttpServer(sellerToken: string): Promise<void> {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    if (req.method === "OPTIONS") {
      res.status(204).send();
      return;
    }
    next();
  });

  // sessionId → transport (for routing subsequent requests to correct session)
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function cleanupSession(sessionId: string): void {
    transports.delete(sessionId);
    delete connectionsBySessionId[sessionId];
  }

  app.get("/health-check", (_req, res) => {
    res.json({ success: true, sessions: transports.size });
  });

  // Handles both new session init (no mcp-session-id header) and existing session requests
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        res.status(404).json({ success: false, message: "Session not found or expired" });
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — each session gets its own transport + McpServer instance
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
        connectionsBySessionId[newSessionId] = { transport, sellerToken };
        transport.onclose = () => cleanupSession(newSessionId);
      },
    });

    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // SSE stream for server-to-client messages on an existing session
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ success: false, message: "Missing mcp-session-id header" });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ success: false, message: "Session not found or expired" });
      return;
    }

    await transport.handleRequest(req, res);
  });

  // Client-initiated session termination
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.close();
        cleanupSession(sessionId);
      }
    }

    res.status(200).json({ success: true });
  });

  app.use((_req, res) => {
    res.status(404).json({ success: false, message: "Not found" });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if ("status" in err && (err as { status?: number }).status === 400 && "body" in err) {
      res.status(400).json({ success: false, message: "Invalid JSON payload" });
      return;
    }
    console.error(`Request error: ${err.stack}`);
    res.status(500).json({ success: false, message: "Something went wrong" });
  });

  process.on("uncaughtException", (error: Error) => {
    console.error(`Uncaught Exception: ${error.stack}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    console.error(`Unhandled Rejection: ${reason}`);
  });

  return new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`Shiprocket MCP HTTP server running on http://localhost:${PORT}`);
      resolve();
    });
  });
}

(async () => {
  try {
    const sellerEmail = process.env.SELLER_EMAIL;
    const sellerPassword = process.env.SELLER_PASSWORD;

    if (!sellerEmail || !sellerPassword) {
      throw new Error("SELLER_EMAIL and SELLER_PASSWORD are required in ENV");
    }

    const { data } = await axios.post(
      `${API_DOMAINS.SHIPROCKET}/v1/external/auth/login`,
      { email: sellerEmail, password: sellerPassword }
    );

    await startHttpServer(data.token as string);
  } catch (err) {
    if (err instanceof axios.AxiosError) {
      console.error({ success: false, error: err.response?.data });
    } else if (err instanceof Error) {
      console.error({ success: false, error: err.message });
    }
    process.exit(1);
  }
})();
