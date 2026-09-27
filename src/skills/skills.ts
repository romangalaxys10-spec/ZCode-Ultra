/**
 * Skills: SKILL.md files auto-loaded into the system prompt when their
 * trigger keywords appear in the user's request (Hermes/Claude-Code style).
 * Locations: ~/.zcode-ultra/skills and <workspace>/.zcode-ultra/skills
 */
import fs from "node:fs";
import path from "node:path";
import { dataHome } from "../util.js";

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  source: string;
}

function parseSkillMd(file: string): Skill | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const body = fmMatch[2].trim();
    const get = (key: string): string => {
      const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(fm);
      return m ? m[1].trim() : "";
    };
    const name = get("name") || path.basename(path.dirname(file));
    const description = get("description");
    const triggers = (get("triggers") || get("trigger") || "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (!name || !body) return null;
    return { name, description, triggers, body, source: file };
  } catch {
    return null;
  }
}

export function loadSkills(workspace: string): Skill[] {
  const dirs = [
    path.join(workspace, ".zcode-ultra", "skills"),
    path.join(dataHome(), "skills"),
  ];
  const skills: Skill[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^SKILL\.md$/i.test(entry.name)) {
        const s = parseSkillMd(path.join(dir, entry.name));
        if (s) skills.push(s);
      } else if (entry.isDirectory()) {
        const candidate = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(candidate)) {
          const s = parseSkillMd(candidate);
          if (s) skills.push(s);
        }
      }
    }
  }
  return skills;
}

/** Select skills whose triggers/description match the request. */
export function selectSkills(skills: Skill[], userMessage: string, max = 3): Skill[] {
  const msg = userMessage.toLowerCase();
  const scored = skills
    .map((s) => {
      let score = 0;
      for (const t of s.triggers) if (msg.includes(t)) score += 2;
      for (const word of s.name.toLowerCase().split(/[-_\s]/)) if (word.length > 2 && msg.includes(word)) score += 1;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return scored.map((x) => x.s);
}

export function renderSkills(skills: Skill[]): string[] {
  return skills.map((s) => `<skill name="${s.name}">\n${s.body}\n</skill>`);
}
