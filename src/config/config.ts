/**
 * ZCode Ultra configuration.
 *
 * Layered config (later wins):
 *   1. built-in defaults
 *   2. global:  ~/.zcode-ultra/config.json
 *   3. project: <workspace>/.zcode-ultra.json
 *   4. environment variables (ZCODE_ULTRA_*, provider keys)
 *
 * JSON5-lite: // and /* *\/ comments plus trailing commas are tolerated.
 * Writes are atomic (tmp + rename) — the OpenClaw "doctor-safe" pattern.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { dataHome, atomicWrite } from "../util.js";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "yolo";

export interface ProviderConfig {
  /** provider id, e.g. "zai" | "deepseek" | "openai" | "anthropic" | "ollama" | custom */
  [id: string]: {
    baseUrl: string;
    apiKeyEnv?: string;
    apiKey?: string;
    /** default model id for this provider */
    model?: string;
    /** "openai" (chat/completions) or "anthropic" (/v1/messages) */
    protocol?: "openai" | "anthropic";
    headers?: Record<string, string>;
    /** cost per 1M tokens: in / out (USD) — used by the cost tier router */
    cost?: { in: number; out: number };
  };
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HookConfig {
  /** event: beforeTool | afterTool | beforeStep */
  event: "beforeTool" | "afterTool" | "beforeStep";
  /** regex matched against tool name (or "step" for beforeStep) */
  match?: string;
  /** shell command; exit code 2 blocks the action (beforeTool/beforeStep) */
  run: string;
}

export interface BotGuardConfig {
  /** only these Discord user ids may talk to the bot */
  discordAllowUsers?: string[];
  /** only these WhatsApp numbers (E.164 without +) may talk to the bot */
  whatsappAllowNumbers?: string[];
  /** require mention in guild channels */
  requireMentionInGuilds?: boolean;
}

export interface Config {
  /** default model in "provider/model" form */
  model: string;
  /** fallback chain used when the primary fails, same "provider/model" form */
  fallbackModels: string[];
  /** auto-fallback to cheaper model for trivial requests */
  maxOutputTokens: number;
  permissionMode: PermissionMode;
  /** commands that never require approval (prefix match) */
  allowedCommands: string[];
  /** commands that always require approval (prefix match) */
  blockedCommands: string[];
  /** sandbox: off | docker */
  sandbox: "off" | "docker";
  /** docker image used when sandbox = docker */
  sandboxImage: string;
  /** path allowlist for file tools; empty = workspace only */
  extraAllowedPaths: string[];
  providers: ProviderConfig;
  mcpServers: Record<string, McpServerConfig>;
  hooks: HookConfig[];
  memoryEnabled: boolean;
  autoCompact: boolean;
  /** compact when estimated tokens exceed this */
  compactThreshold: number;
  /** keep this many recent messages verbatim when compacting */
  compactKeepRecent: number;
  discord: { enabled: boolean; tokenEnv: string; guildId?: string };
  whatsapp: {
    enabled: boolean;
    /** baileys (unofficial QR) | cloud (Meta Cloud API) */
    mode: "baileys" | "cloud" | "off";
    triggerPrefix: string;
    cloud?: {
      tokenEnv: string;
      phoneNumberId: string;
      verifyToken: string;
      port: number;
    };
  };
  botGuard: BotGuardConfig;
  /** max turns per agent run — runaway protection */
  maxTurns: number;
  /** parallel tool execution enabled */
  parallelTools: boolean;
  telemetry: boolean;
}

export const DEFAULT_CONFIG: Config = {
  model: "zai/glm-4.6",
  fallbackModels: [],
  maxOutputTokens: 8192,
  permissionMode: "default",
  allowedCommands: [
    "ls", "cat", "head", "tail", "grep", "rg", "find", "echo", "pwd",
    "node", "npm", "npx", "pnpm", "bun", "python", "python3", "pip",
    "git status", "git diff", "git log", "git show", "git add", "git commit",
    "git branch", "git checkout", "git switch", "git push", "git pull",
    "cargo", "go", "make", "cmake", "tsc", "eslint", "prettier", "pytest", "ruff",
  ],
  blockedCommands: [
    "rm -rf /", "rm -rf ~", "sudo", "mkfs", "dd if=", ":(){", "shutdown",
    "reboot", "halt", "chmod -R 777 /", "curl * | bash", "wget * | sh",
  ],
  sandbox: "off",
  sandboxImage: "node:22-slim",
  extraAllowedPaths: [],
  providers: {},
  mcpServers: {},
  hooks: [],
  memoryEnabled: true,
  autoCompact: true,
  compactThreshold: 90000,
  compactKeepRecent: 12,
  discord: { enabled: false, tokenEnv: "ZCODE_ULTRA_DISCORD_TOKEN" },
  whatsapp: {
    enabled: false,
    mode: "off",
    triggerPrefix: "!z ",
    cloud: { tokenEnv: "ZCODE_ULTRA_WA_TOKEN", phoneNumberId: "", verifyToken: "", port: 8788 },
  },
  botGuard: { requireMentionInGuilds: true },
  maxTurns: 60,
  parallelTools: true,
  telemetry: false,
};

/**
 * Built-in provider presets. Users can override or add providers in config.
 * Costs are approximate, USD per 1M tokens, used for tier routing hints only.
 */
export const BUILTIN_PROVIDERS: ProviderConfig = {
  zai: {
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    model: "glm-4.6",
    protocol: "openai",
    cost: { in: 0.6, out: 2.2 },
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
    model: "glm-4.6",
    protocol: "openai",
    cost: { in: 0.6, out: 2.2 },
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-chat",
    protocol: "openai",
    cost: { in: 0.27, out: 1.1 },
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-4.1",
    protocol: "openai",
    cost: { in: 2.0, out: 8.0 },
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-5",
    protocol: "anthropic",
    cost: { in: 3.0, out: 15.0 },
  },
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    model: "kimi-k2-0905-preview",
    protocol: "openai",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "QWEN_API_KEY",
    model: "qwen3-coder-plus",
    protocol: "openai",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "",
    model: "qwen3-coder:30b",
    protocol: "openai",
    cost: { in: 0, out: 0 },
  },
  lmstudio: {
    baseUrl: "http://localhost:1234/v1",
    apiKeyEnv: "",
    model: "local-model",
    protocol: "openai",
    cost: { in: 0, out: 0 },
  },
  vllm: {
    baseUrl: "http://localhost:8000/v1",
    apiKeyEnv: "",
    model: "local-model",
    protocol: "openai",
    cost: { in: 0, out: 0 },
  },
};

/** Strip //, /* *\/ comments and trailing commas so JSON.parse accepts JSON5-lite. */
export function parseJsonLite(text: string): unknown {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  // remove trailing commas
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return parseJsonLite(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Failed to parse config file ${file}: ${(e as Error).message}`);
  }
}

/** Deep-merge a into b (a wins); objects merge recursively, arrays/atoms replace. */
export function deepMerge<T>(a: unknown, base: T): T {
  if (a === null || a === undefined) return base;
  if (typeof a !== "object" || Array.isArray(a) || typeof base !== "object" || base === null || Array.isArray(base)) {
    return a as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
    out[k] = deepMerge(v, (base as Record<string, unknown>)[k]);
  }
  return out as T;
}

export interface LoadedConfig {
  config: Config;
  workspace: string;
  globalConfigPath: string;
  projectConfigPath: string | null;
}

export function loadConfig(workspace: string): LoadedConfig {
  const globalConfigPath = path.join(dataHome(), "config.json");
  const projectConfigPath = path.join(workspace, ".zcode-ultra.json");

  let cfg: Config = structuredClone(DEFAULT_CONFIG);

  const g = readJsonFile(globalConfigPath);
  if (g) cfg = deepMerge(g, cfg);

  const p = readJsonFile(projectConfigPath);
  if (p) cfg = deepMerge(p, cfg);

  // Environment overrides
  if (process.env.ZCODE_ULTRA_MODEL) cfg.model = process.env.ZCODE_ULTRA_MODEL;
  if (process.env.ZCODE_ULTRA_PERMISSION_MODE)
    cfg.permissionMode = process.env.ZCODE_ULTRA_PERMISSION_MODE as PermissionMode;
  if (process.env.ZCODE_ULTRA_SANDBOX) cfg.sandbox = process.env.ZCODE_ULTRA_SANDBOX as Config["sandbox"];

  return { config: cfg, workspace: path.resolve(workspace), globalConfigPath, projectConfigPath: fs.existsSync(projectConfigPath) ? projectConfigPath : null };
}

export function saveGlobalConfig(config: Config): string {
  const file = path.join(dataHome(), "config.json");
  atomicWrite(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

/** Resolve "provider/model" -> resolved provider config + model id. */
export function resolveModelRef(cfg: Config, ref: string): { providerId: string; model: string; baseUrl: string; apiKey: string; protocol: "openai" | "anthropic"; headers: Record<string, string>; extra: Partial<ProviderConfig[string]> } {
  const [providerId, ...rest] = ref.split("/");
  const model = rest.join("/") || "";
  const merged = { ...BUILTIN_PROVIDERS, ...cfg.providers };
  const p = merged[providerId];
  if (!p) throw new Error(`Unknown provider "${providerId}". Available: ${Object.keys(merged).join(", ")}`);
  const apiKey = p.apiKey ?? (p.apiKeyEnv ? process.env[p.apiKeyEnv] ?? "" : "");
  return {
    providerId,
    model: model || p.model || "",
    baseUrl: p.baseUrl.replace(/\/$/, ""),
    apiKey,
    protocol: p.protocol ?? "openai",
    headers: p.headers ?? {},
    extra: p,
  };
}

export function configDirExample(): string {
  return path.join(os.homedir(), ".zcode-ultra", "config.json");
}
