/**
 * Load the bundled `todo-discipline` skill for registration through
 * `ctx.skill.transform`.
 *
 * OpenCode's `Skill.Info` wants the frontmatter parsed apart from the body,
 * so the file on disk is read once at setup and split here.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
}

/** Split YAML frontmatter from the markdown body, keeping flat string values. */
export function splitFrontmatter(text: string): {
  data: Record<string, string>;
  body: string;
} {
  const data: Record<string, string> = {};
  if (!text.startsWith("---")) return { data, body: text };
  const lines = text.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data, body: text };
  for (const line of lines.slice(1, end)) {
    if (line === undefined || line.trim() === "" || /^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") data[key] = value;
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

/**
 * Read one skill directory. Returns undefined when the file is missing or
 * malformed, so a broken bundle degrades to "no skill" instead of a plugin
 * load failure that would take the todo tool down with it.
 */
export function loadSkill(skillsDir: string, id: string): SkillDefinition | undefined {
  const skillPath = join(skillsDir, id, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(skillPath, "utf8");
  } catch {
    return undefined;
  }
  const { data, body } = splitFrontmatter(text);
  const name = (data.name ?? id).trim();
  const description = (data.description ?? "").trim();
  const content = body.trim();
  if (!name || !description || !content) return undefined;
  if (!isAbsolute(skillPath)) return undefined;
  return { id, name, description, path: skillPath, content: `${content}\n` };
}
