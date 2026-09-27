/**
 * Minimal MCP (Model Context Protocol) client for stdio servers.
 * Hand-rolled JSON-RPC 2.0 — zero dependencies. Supports initialize,
 * tools/list, tools/call with proper lifecycle (spawn -> init -> use -> kill).
 *
 * The full MCP spec allows SSE/streamable-http transports; stdio covers the
 * vast majority of local servers. HTTP transport lands in v1.1.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { shortId } from "../util.js";

export interface McpTool {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** namespaced tool id exposed to the model: mcp__<server>__<tool> */
  qualifiedName: string;
}

export class McpConnection {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private initialized = false;

  constructor(
    public readonly name: string,
    private command: string,
    private args: string[],
    private env: Record<string, string> = {}
  ) {}

  async connect(): Promise<void> {
    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", () => {
      /* server logs — ignore */
    });
    this.proc.on("exit", (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP server "${this.name}" exited (code ${code})`));
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "zcode-ultra", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(String(msg.id))) {
          const p = this.pending.get(String(msg.id))!;
          this.pending.delete(String(msg.id));
          if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } catch {
        /* not JSON — ignore */
      }
    }
  }

  private send(msg: Record<string, unknown>): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = shortId(8);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out on server "${this.name}"`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) return [];
    const res = await this.request("tools/list", {});
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools.map((t: any) => ({
      serverName: this.name,
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      qualifiedName: `mcp__${this.name}__${t.name}`,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res?.isError) {
      const text = this.extractText(res);
      throw new Error(text || "MCP tool error");
    }
    return this.extractText(res);
  }

  private extractText(res: any): string {
    const content = res?.content;
    if (Array.isArray(content)) {
      return content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n") || JSON.stringify(content);
    }
    return JSON.stringify(res ?? {});
  }

  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* already dead */
    }
    this.proc = null;
  }
}

export class McpHub {
  private connections: McpConnection[] = [];

  async connectAll(servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }> {
    const connected: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const [name, cfg] of Object.entries(servers)) {
      const conn = new McpConnection(name, cfg.command, cfg.args ?? [], cfg.env ?? {});
      try {
        await conn.connect();
        this.connections.push(conn);
        connected.push(name);
      } catch (e) {
        failed.push({ name, error: (e as Error).message });
        conn.kill();
      }
    }
    return { connected, failed };
  }

  async allTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    for (const conn of this.connections) {
      try {
        out.push(...(await conn.listTools()));
      } catch {
        /* server down — skip */
      }
    }
    return out;
  }

  async call(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const parts = qualifiedName.split("__");
    if (parts.length < 3 || parts[0] !== "mcp") throw new Error(`Invalid MCP tool id: ${qualifiedName}`);
    const serverName = parts[1];
    const toolName = parts.slice(2).join("__");
    const conn = this.connections.find((c) => c.name === serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" not connected`);
    return conn.callTool(toolName, args);
  }

  shutdown(): void {
    for (const c of this.connections) c.kill();
    this.connections = [];
  }
}

/**
 * Bridge MCP tools into the ToolRegistry as regular ToolDefs so the agent
 * treats them identically to built-in tools (OpenClaw's thin-adapter idea).
 */
import type { ToolDef } from "../tools/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

export function mcpToolDefs(hub: McpHub, tools: McpTool[]): ToolDef[] {
  return tools.map((t) => {
    const def: ToolDef = {
      name: t.qualifiedName,
      description: `[MCP:${t.serverName}] ${t.description || t.name}`,
      parameters: t.inputSchema,
      readOnly: false,
      async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        try {
          const out = await hub.call(t.qualifiedName, input);
          return { output: out.slice(0, 30_000) };
        } catch (e) {
          return { output: `Error: ${(e as Error).message}`, isError: true };
        }
      },
    };
    return def;
  });
}
