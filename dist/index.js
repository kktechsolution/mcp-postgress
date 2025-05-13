import express from "express";
import { randomUUID } from "crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    isInitializeRequest,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Pool } from "pg";

const app = express();
app.use(express.json());
// Map to store transports by session ID
const transports = {};
// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'];
    let transport;
    if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
    }
    else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                // Store the transport by session ID
                transports[sessionId] = transport;
            }
        });
        // Clean up transport when closed
        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
            }
        };

        const server = new Server(
          {
            name: "example-servers/postgres",
            version: "0.1.0",
          },
          {
            capabilities: {
              resources: {},
              tools: {},
            },
          }
        );
        const args = process.argv.slice(2);
        if (args.length === 0) {
          console.error(
            "Please provide a database URL as a command-line argument"
          );
          process.exit(1);
        }
        const databaseUrl = args[0];
        const resourceBaseUrl = new URL(databaseUrl);
        resourceBaseUrl.protocol = "postgres:";
        resourceBaseUrl.password = "";
        const pool = new Pool({
          connectionString: databaseUrl,
        });
        const SCHEMA_PATH = "schema";
        server.setRequestHandler(ListResourcesRequestSchema, async () => {
          const client = await pool.connect();
          try {
            const result = await client.query(
              "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
            );
            return {
              resources: result.rows.map((row) => ({
                uri: new URL(
                  `${row.table_name}/${SCHEMA_PATH}`,
                  resourceBaseUrl
                ).href,
                mimeType: "application/json",
                name: `"${row.table_name}" database schema`,
              })),
            };
          } finally {
            client.release();
          }
        });
        server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
          const resourceUrl = new URL(request.params.uri);
          const pathComponents = resourceUrl.pathname.split("/");
          const schema = pathComponents.pop();
          const tableName = pathComponents.pop();
          if (schema !== SCHEMA_PATH) {
            throw new Error("Invalid resource URI");
          }
          const client = await pool.connect();
          try {
            const result = await client.query(
              "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
              [tableName]
            );
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: "application/json",
                  text: JSON.stringify(result.rows, null, 2),
                },
              ],
            };
          } finally {
            client.release();
          }
        });
        server.setRequestHandler(ListToolsRequestSchema, async () => {
          return {
            tools: [
              {
                name: "query",
                description: "Run a read-only SQL query",
                inputSchema: {
                  type: "object",
                  properties: {
                    sql: { type: "string" },
                  },
                },
              },
            ],
          };
        });
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          if (request.params.name === "query") {
            const sql = request.params.arguments?.sql;
            const client = await pool.connect();
            try {
              await client.query("BEGIN TRANSACTION READ ONLY");
              const result = await client.query(sql);
              return {
                content: [
                  { type: "text", text: JSON.stringify(result.rows, null, 2) },
                ],
                isError: false,
              };
            } catch (error) {
              throw error;
            } finally {
              client
                .query("ROLLBACK")
                .catch((error) =>
                  console.warn("Could not roll back transaction:", error)
                );
              client.release();
            }
          }
          throw new Error(`Unknown tool: ${request.params.name}`);
        });
        // ... set up server resources, tools, and prompts ...
        // Connect to the MCP server
        await server.connect(transport);
    }
    else {
        // Invalid request
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
            },
            id: null,
        });
        return;
    }
    // Handle the request
    await transport.handleRequest(req, res, req.body);
});
// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};
// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', handleSessionRequest);
// Handle DELETE requests for session termination
app.delete('/mcp', handleSessionRequest);
app.listen(3000);
