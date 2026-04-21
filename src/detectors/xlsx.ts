import { basename } from "node:path";
import type { Detector } from "./types.js";
import type { RawSourceFormat } from "../types.js";
import { baseContext, countByExt, readCname, walkAll } from "./common.js";

/**
 * Spreadsheet detector. Triggers when the source is dominated by
 * `.xlsx` / `.xls` / `.csv` / `.tsv` files. Typical shapes:
 *
 *   - One big xlsx with a `posts` sheet (each row → one post)
 *   - A folder of CSVs, each representing a collection
 *   - A single `data.csv` that should be imported as posts
 *
 * Conversion is delegated to `src/prompts/convert-xlsx.md` which tells
 * Copilot to read headers, map columns to WordPress fields, and emit
 * one markdown file per row.
 */
export const xlsxDetector: Detector = {
  name: "xlsx-sheet",
  priority: 34,

  async match(dir) {
    const files = await walkAll(dir, 6);
    const counts = countByExt(files);
    const sheetCount =
      (counts[".xlsx"] ?? 0) +
      (counts[".xlsm"] ?? 0) +
      (counts[".xls"] ?? 0) +
      (counts[".csv"] ?? 0) +
      (counts[".tsv"] ?? 0);
    if (sheetCount === 0) return 0;
    const otherContent =
      (counts[".md"] ?? 0) +
      (counts[".html"] ?? 0) +
      (counts[".mdx"] ?? 0) +
      (counts[".docx"] ?? 0);
    if (sheetCount >= 1 && otherContent === 0) return 0.85;
    if (sheetCount >= otherContent * 2) return 0.65;
    return 0.3;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "xlsx-sheet";
    out.siteTitle = basename(dir).replace(/[-_]+/g, " ");
    out.domain = await readCname(dir);

    const files = await walkAll(dir, 8);
    const sheets = files.filter((f) => /\.(xlsx|xlsm|xls|csv|tsv)$/i.test(f));
    out.rawSources = sheets.map((path) => ({
      path,
      format: formatForExt(path),
      postType: "post",
      hint: "each row is one post unless the sheet name says otherwise",
    }));
    out.collections.push({
      name: "posts",
      dir,
      permalink: "/:slug/",
      count: sheets.length,
    });
    out.dataFiles = sheets;
    out.detectorBriefing =
      `Source is a spreadsheet dump (${sheets.length} sheet file(s)). Treat the primary ` +
      `sheet as a table of posts where header row = field names. Common columns: ` +
      `title, slug, date, body/content, tags, categories, excerpt, author, image. If ` +
      `multiple sheets exist, each non-header sheet is its own collection (name it ` +
      `after the sheet). Skip rows where the title cell is empty.`;
    return out;
  },
};

function formatForExt(path: string): RawSourceFormat {
  if (/\.(csv|tsv)$/i.test(path)) return "csv";
  return "xlsx";
}
