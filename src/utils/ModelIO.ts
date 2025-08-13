// src/utils/ModelIO.ts
import {
  writeFilesPayload,
  type AICoderJsonPayload,
} from '../agents/WorkspaceWriter';

/** Describes one file to write into the workspace. */
export interface GeneratedFile {
  /** POSIX-style relative path inside the workspace (use forward slashes). */
  path: string;
  /** Full file contents to write verbatim. */
  content: string;
  /** Optional: mark as executable (e.g., shell scripts). */
  executable?: boolean;
}

/** Complete payload returned by the model. */
export interface GeneratedProject {
  files: GeneratedFile[];
  /** Optional command to run after files are written (e.g., "npm install"). */
  postInstall?: string;
  /** Optional command to start the project (e.g., "npm run dev"). */
  start?: string;
}

const START = '<AICODER_JSON>';
const END = '</AICODER_JSON>';

/**
 * Extract our strict JSON payload from a model response.
 * Supports either:
 *   1) <AICODER_JSON> ... </AICODER_JSON>
 *   2) ```json ... ```
 */
export function extractProjectFromResponse(text: string): GeneratedProject | null {
  if (!text) {return null;}

  // Preferred: <AICODER_JSON> ... </AICODER_JSON>
  const tagStart = text.indexOf(START);
  const tagEnd = text.indexOf(END);
  if (tagStart !== -1 && tagEnd !== -1 && tagEnd > tagStart) {
    const jsonStr = text.slice(tagStart + START.length, tagEnd).trim();
    return safeParse(jsonStr);
  }

  // Fallback: fenced code block ```json ... ```
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (m && m[1]) {
    return safeParse(m[1].trim());
  }

  return null;
}

/**
 * VERY forgiving fallback:
 * - Strips any markdown fences
 * - Attempts to find the first top-level JSON object (quote-aware)
 * - Parses if it has a "files" array
 */
export function extractProjectFromResponseLoose(text: string): GeneratedProject | null {
  if (!text) {return null;}

  const clean = stripMarkdownFences(text).trim();

  // Find the first '{' as a candidate start of a JSON object
  const start = clean.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString: '"' | "'" | null = null;
    let escaped = false;

    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];

      if (inString) {
        // Inside a string: respect escapes and closing quote
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === inString) {
          inString = null; // string closed
        }
        continue;
      }

      // Not inside a string — entering a string?
      if (ch === '"' || ch === "'") {
        inString = ch as '"' | "'";
        continue;
      }

      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = clean.slice(start, i + 1).trim();
          const parsed = safeParse(candidate);
          if (parsed?.files && Array.isArray(parsed.files)) {return parsed;}
          break;
        }
      }
    }
  }

  // Last resort: try parsing the entire fence-stripped string
  return safeParse(clean);
}

/**
 * Remove any kind of triple-backtick fence so we can JSON.parse easily.
 * - Keeps the content inside the first fenced block if present
 * - Otherwise returns text with all fences stripped
 */
export function stripMarkdownFences(text: string): string {
  if (!text) {return text;}

  // If there is an explicit fenced block, prefer the first one’s inner content
  const fenceMatch = text.match(/```(?:json|[\w-]+)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }

  // Otherwise, just remove any stray fences
  return text.replace(/```(?:json|[\w-]+)?\s*([\s\S]*?)```/g, '$1').trim();
}

function safeParse(jsonStr: string): GeneratedProject | null {
  try {
    const obj = JSON.parse(jsonStr);
    if (!obj || !Array.isArray(obj.files)) {return null;}
    return obj as GeneratedProject;
  } catch {
    return null;
  }
}

// ADDITIONS ↓↓↓

function parseAnyProject(jsonLike: string): GeneratedProject | null {
  try {
    const obj = JSON.parse(jsonLike);
    if (obj && Array.isArray((obj as any).files)) {
      return obj as GeneratedProject;
    }
  } catch (_) {}
  return null;
}

/** One call that tries: <AICODER_JSON>, ```json fences, raw JSON, and quote-aware loose scan. */
export function parseProjectFromAnyText(text: string): GeneratedProject | null {
  if (!text) {return null;}

  // 1) Strict tag
  const strict = extractProjectFromResponse(text);
  if (strict) {return strict;}

  // 2) Fenced or fence-stripped block
  const fencedInner = stripMarkdownFences(text).trim();
  const raw = parseAnyProject(fencedInner);
  if (raw) {return raw;}

  // 3) Quote-aware loose scan (handles prose + JSON in same reply)
  const loose = extractProjectFromResponseLoose(text);
  if (loose) {return loose;}

  // 4) Last-chance: if the whole reply itself is raw JSON
  return parseAnyProject(text.trim());
}

// ADDITIONS ↑↑↑

/**
 * System instruction for the model: forces strict, JSON-only output that your
 * extension can parse and write to disk without manual cleanup.
 */
export const STRUCTURED_OUTPUT_INSTRUCTION = [
  'Return your final answer ONLY as a single JSON block wrapped in:',
  '<AICODER_JSON>',
  '{',
  '  "files": [',
  '    { "path": "folder/name.ext", "content": "FULL FILE CONTENT (string)", "executable": false }',
  '  ],',
  '  "postInstall": "optional shell command",',
  '  "start": "optional shell command"',
  '}',
  '</AICODER_JSON>',
  '',
  'ABSOLUTE RULES:',
  '- No prose, no explanations, no markdown outside the block.',
  '- The JSON MUST be syntactically valid.',
  '- Each file "content" must be COMPLETE and represented as a JSON string (escape quotes, use \\n for newlines).',
  '- Use FORWARD SLASHES in paths.',
  '- Do NOT include triple backticks.',
].join('\n');

/**
 * Thin wrapper for backwards compatibility with earlier references to `writeProjectFiles`.
 * Normalizes to the workspace writer payload and returns created/updated counts.
 */
export async function writeProjectFiles(
  payload: GeneratedProject
): Promise<{ created: number; updated: number }> {
  const normalized: AICoderJsonPayload = {
    files: payload.files.map(f => ({
      path: f.path,
      content: f.content,
      executable: f.executable,
    })),
    postInstall: payload.postInstall,
    start: payload.start,
  };

  return writeFilesPayload(normalized);
}
