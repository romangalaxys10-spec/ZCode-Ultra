/**
 * Checkpoints (Cline shadow-git + Gemini CLI checkpointing pattern, zero-dep):
 * before any Write/Edit mutates a file, a content-addressed snapshot of the
 * workspace text files is stored under ~/.zcode-ultra/checkpoints/<ws-hash>/.
 *
 * - Blobs are deduplicated by sha256 across snapshots.
 * - Restoring puts file states back exactly as snapshotted; files created
 *   after the snapshot are reported (and only removed with restoreFiles:false).
 * - Snapshots are pruned to the most recent MAX_SNAPSHOTS per workspace.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataHome, ensureDir, nowIso, shortId } from "../util.js";

const MAX_SNAPSHOTS = 30;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BLOBS_PER_SNAPSHOT = 3000;
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".css",
  ".scss", ".html", ".yml", ".yaml", ".toml", ".xml", ".py", ".go", ".rs",
  ".java", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql", ".graphql", ".vue",
  ".svelte", ".astro", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".kt",
  ".env", ".gitignore", ".editorconfig", ".lock", ".csv", ".ini", ".conf",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".cache",
  "coverage", "__pycache__", ".venv", "venv", ".turbo", ".pytest_cache",
  "vendor", ".svelte-kit", ".zcode-ultra",
]);

export interface CheckpointMeta {
  id: string;
  ts: string;
  workspace: string;
  label: string;
  files: number;
}

interface Manifest extends CheckpointMeta {
  entries: Array<{ rel: string; sha: string }>;
}

function wsHash(workspace: string): string {
  return crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12);
}

function cpDir(workspace: string): string {
  return path.join(dataHome(), "checkpoints", wsHash(workspace));
}

function blobsDir(workspace: string): string {
  return path.join(cpDir(workspace), "blobs");
}

function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (ext) return TEXT_EXTENSIONS.has(ext);
  return name.startsWith(".") || !name.includes(".");
}

function walkFiles(root: string, budget: { count: number }): string[] {
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length && budget.count > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (budget.count <= 0) break;
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 10) queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && isTextFile(e.name)) {
        try {
          if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        } catch {
          continue;
        }
        out.push(full);
        budget.count--;
      }
    }
  }
  return out;
}

/** Snapshot the workspace; returns checkpoint id. Cheap when nothing changed (dedupe). */
export function createCheckpoint(workspace: string, label: string): string | null {
  try {
    const dir = cpDir(workspace);
    ensureDir(blobsDir(workspace));
    const budget = { count: MAX_TOTAL_BLOBS_PER_SNAPSHOT };
    const files = walkFiles(workspace, budget);
    const entries: Array<{ rel: string; sha: string }> = [];

    for (const full of files) {
      const rel = path.relative(workspace, full).split(path.sep).join("/");
      const content = fs.readFileSync(full);
      const sha = crypto.createHash("sha256").update(content).digest("hex").slice(0, 24);
      const blobPath = path.join(blobsDir(workspace), sha);
      if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, content);
      entries.push({ rel, sha });
    }

    const id = `cp_${Date.now().toString(36)}_${shortId(4)}`;
    const manifest: Manifest = {
      id,
      ts: nowIso(),
      workspace: path.resolve(workspace),
      label: label.slice(0, 120),
      files: entries.length,
      entries,
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(manifest));
    prune(workspace);
    return id;
  } catch {
    return null; // checkpointing must never break the agent loop
  }
}

function readManifest(workspace: string, id: string): Manifest | null {
  try {
    const file = path.join(cpDir(workspace), `${id}.json`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

export function listCheckpoints(workspace: string): CheckpointMeta[] {
  const dir = cpDir(workspace);
  if (!fs.existsSync(dir)) return [];
  const out: CheckpointMeta[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("cp_") && f.endsWith(".json")).sort()) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Manifest;
      out.push({ id: m.id, ts: m.ts, workspace: m.workspace, label: m.label, files: m.files });
    } catch {
      /* skip */
    }
  }
  return out.reverse();
}

/** Restore files to a snapshot. Returns a human-readable report. */
export function restoreCheckpoint(workspace: string, id: string, opts: { deleteNewFiles: boolean }): string {
  const m = readManifest(workspace, id);
  if (!m) return `Error: checkpoint not found: ${id}`;
  const snapshotted = new Set(m.entries.map((e) => e.rel));
  let restored = 0;
  for (const e of m.entries) {
    const blobPath = path.join(blobsDir(workspace), e.sha);
    if (!fs.existsSync(blobPath)) continue;
    const target = path.join(workspace, ...e.rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(blobPath));
    restored++;
  }
  let removedNote = "";
  if (opts.deleteNewFiles) {
    let removed = 0;
    const budget = { count: MAX_TOTAL_BLOBS_PER_SNAPSHOT };
    for (const full of walkFiles(workspace, budget)) {
      const rel = path.relative(workspace, full).split(path.sep).join("/");
      if (!snapshotted.has(rel)) {
        try {
          fs.rmSync(full);
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    removedNote = removed > 0 ? `, removed ${removed} file(s) created after the checkpoint` : "";
  } else {
    const budget = { count: MAX_TOTAL_BLOBS_PER_SNAPSHOT };
    const nowPresent = walkFiles(workspace, budget).map((f) => path.relative(workspace, f).split(path.sep).join("/"));
    const created = nowPresent.filter((r) => !snapshotted.has(r));
    if (created.length > 0) removedNote = ` (kept ${created.length} file(s) created after the checkpoint: ${created.slice(0, 5).join(", ")}${created.length > 5 ? "…" : ""})`;
  }
  return `Restored ${restored}/${m.files} file(s) from ${id}${removedNote}.`;
}

function prune(workspace: string): void {
  try {
    const dir = cpDir(workspace);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("cp_") && f.endsWith(".json")).sort();
    const excess = files.length - MAX_SNAPSHOTS;
    for (let i = 0; i < excess; i++) fs.rmSync(path.join(dir, files[i]!), { force: true });
  } catch {
    /* best-effort */
  }
}
