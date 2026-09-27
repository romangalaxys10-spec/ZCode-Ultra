/**
 * Safety: permission modes, exec approvals bound to exact argv + cwd,
 * path allowlists, blocked/allowed command rules, secret scrubbing.
 *
 * Patterns consolidated from: Codex CLI (defense-in-depth), OpenClaw
 * (argv-identity-bound approvals), Moltis (security-first posture).
 */
import fs from "node:fs";
import path from "node:path";
import type { Config, PermissionMode } from "../config/config.js";

export interface ApprovalRequest {
  tool: string;
  /** human-readable summary of the operation */
  summary: string;
  /** exact command argv for exec tools */
  argv?: string[];
  cwd?: string;
  /** target file path for file tools */
  filePath?: string;
  risk: "low" | "medium" | "high";
}

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export const MODE_INFO: Record<PermissionMode, string> = {
  plan: "Plan mode — read-only research, no writes or commands",
  default: "Default — safe ops run, writes/commands need approval",
  acceptEdits: "Accept edits — file edits auto-approved, commands need approval",
  yolo: "YOLO — everything auto-approved (sandbox strongly advised)",
};

function commandRisk(argv: string[]): "low" | "medium" | "high" {
  const cmd = argv.join(" ");
  const high = /(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|>\s*\/dev\/sd|chmod\s+-R\s+777\s+\/|curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh|git\s+push\s+--force|npm\s+publish|docker\s+system\s+prune)/i;
  const medium = /(rm|mv|git\s+(push|reset|rebase|clean)|npm\s+(i|install|uninstall)|pip\s+(install|uninstall)|kill|pkill|chmod|chown|curl|wget|tar|unzip|docker)/i;
  if (high.test(cmd)) return "high";
  if (medium.test(cmd)) return "medium";
  return "low";
}

function commandAllowed(cfg: Config, argv: string[]): boolean {
  const cmd = argv.join(" ");
  for (const blocked of cfg.blockedCommands) {
    if (blocked.includes("*")) {
      const re = new RegExp("^" + blocked.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"), "i");
      if (re.test(cmd)) return false;
    } else if (cmd.toLowerCase().startsWith(blocked.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function needsExplicitAllow(cfg: Config, argv: string[]): boolean {
  const cmd = argv.join(" ");
  return !cfg.allowedCommands.some((a) => cmd.toLowerCase().startsWith(a.toLowerCase()));
}

export interface SafetyContext {
  cfg: Config;
  workspace: string;
  handler: ApprovalHandler | null;
}

export function makeSafety(cfg: Config, workspace: string, handler: ApprovalHandler | null): SafetyContext {
  return { cfg, workspace: path.resolve(workspace), handler };
}

/** Path allowlist: workspace + declared extras. Blocks dotfile secrets outside workspace. */
export function pathAllowed(safety: SafetyContext, target: string): boolean {
  const resolved = path.resolve(target);
  const allowed = [safety.workspace, ...safety.cfg.extraAllowedPaths.map((p) => path.resolve(p)), path.join(safety.workspace, ".zcode-ultra")];
  const inside = allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) return false;
  // allow reading home dotfiles only if explicitly in extraAllowedPaths
  return true;
}

/** Decide whether a tool call may proceed without user approval. */
export async function checkApproval(safety: SafetyContext, req: ApprovalRequest): Promise<ApprovalDecision> {
  const mode = safety.cfg.permissionMode;

  if (mode === "plan" && (req.tool === "Write" || req.tool === "Edit" || req.tool === "Bash" || req.tool === "NotebookEdit")) {
    return { approved: false, reason: "Plan mode is read-only. Switch out of plan mode to make changes." };
  }

  if (req.tool === "Bash") {
    const argv = req.argv ?? [];
    if (!commandAllowed(safety.cfg, argv)) {
      return { approved: false, reason: `Command matches blockedCommands rule: ${argv.join(" ")}` };
    }
    if (mode === "yolo") return { approved: true, reason: "yolo mode" };
    const requiresApproval = req.risk === "high" || req.risk === "medium" || needsExplicitAllow(safety.cfg, argv);
    if (!requiresApproval) return { approved: true, reason: "allowlisted read/safe command" };
    if (!safety.handler) return { approved: false, reason: "no approval handler available in non-interactive context" };
    return safety.handler(req);
  }

  if (req.tool === "Write" || req.tool === "Edit" || req.tool === "NotebookEdit") {
    if (!pathAllowed(safety, req.filePath ?? "")) {
      return { approved: false, reason: `Path outside workspace: ${req.filePath}. Add it to extraAllowedPaths.` };
    }
    if (mode === "acceptEdits" || mode === "yolo") return { approved: true, reason: mode + " mode" };
    if (!safety.handler) return { approved: false, reason: "no approval handler available in non-interactive context" };
    return safety.handler(req);
  }

  if (req.tool === "WebFetch" && mode === "plan") return { approved: true, reason: "read-only fetch allowed in plan mode" };
  return { approved: true, reason: "read-only tool" };
}

export function bashRisk(argv: string[]): "low" | "medium" | "high" {
  return commandRisk(argv);
}

/**
 * Secret scrubbing — never let API keys leak into tool outputs or logs.
 * Applied to every tool result and bot outbound message.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b/g, replacement: "gh?_***REDACTED***" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "sk-***REDACTED***" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "AKIA***REDACTED***" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "xox?-***REDACTED***" },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "jwt***REDACTED***" },
  { re: /(?:api[_-]?key|apikey|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{12,}["']/gi, replacement: '$1: "***REDACTED***"' },
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const { re, replacement } of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Docker sandbox world: run the argv inside a throwaway container. */
export async function sandboxedExec(
  safety: SafetyContext,
  argv: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  const image = safety.cfg.sandboxImage;
  const containerArgv = [
    "run", "--rm",
    "--network=host", // configurable later; keep local dev functional
    "-v", `${cwd}:/work`,
    "-w", "/work",
    "-e", "HOME=/tmp",
    "--memory=2g", "--cpus=2",
    image,
    "/bin/sh", "-c", argv.join(" "),
  ];
  return new Promise((resolve) => {
    execFile(
      "docker",
      containerArgv,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      }
    );
  });
}

export function dockerAvailable(): boolean {
  try {
    fs.accessSync("/var/run/docker.sock");
    return true;
  } catch {
    return false;
  }
}
