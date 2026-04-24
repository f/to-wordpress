/**
 * Small shared helpers used by every agent's parser.
 */

/**
 * Coerce a variety of content shapes into a single string. Both Copilot
 * and Claude emit text inside arrays of { type, text }, nested objects,
 * or as plain strings.
 */
export function extractText(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const obj = c as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.value === "string") return obj.value;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.value === "string") return obj.value;
  }
  return undefined;
}
