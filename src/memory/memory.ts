/**
 * Memory: durable markdown notes with keyword recall (FTS-lite).
 * File: ~/.zcode-ultra/MEMORY.md — one entry per line-block with date stamp.
 * Recall does a scored keyword scan; entries decay nothing (user-curated).
 */
import fs from "node:fs";
import path from "node:path";
import { dataHome, atomicWrite, nowIso } from "../util.js";

function memoryFile(): string {
  return path.join(dataHome(), "MEMORY.md");
}

export function memoryAppend(note: string): void {
  const file = memoryFile();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# ZCode Ultra Memory\n";
  const entry = `- [${nowIso().slice(0, 10)}] ${note.replace(/\n+/g, " ").trim()}`;
  atomicWrite(file, existing.trimEnd() + "\n" + entry + "\n");
}

export function memoryRecall(query: string, max = 6): string {
  const file = memoryFile();
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- ["));
  if (lines.length === 0) return "";
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
  const scored = lines
    .map((line) => {
      const low = line.toLowerCase();
      let score = 0;
      for (const t of terms) if (low.includes(t)) score += t.length;
      return { line, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return scored.map((x) => x.line).join("\n");
}
