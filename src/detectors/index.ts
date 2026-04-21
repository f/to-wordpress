import type { Detector, DetectorRunResult } from "./types.js";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { jekyllDetector } from "./jekyll.js";
import { hugoDetector } from "./hugo.js";
import { eleventyDetector } from "./eleventy.js";
import { gatsbyDetector } from "./gatsby.js";
import { nextDetector } from "./next.js";
import { ghostDetector } from "./ghost.js";
import { hexoDetector } from "./hexo.js";
import { astroDetector } from "./astro.js";
import { docusaurusDetector } from "./docusaurus.js";
import { mkdocsDetector } from "./mkdocs.js";
import { wpWxrDetector } from "./wp-wxr.js";
import { mediumExportDetector } from "./medium-export.js";
import { substackExportDetector } from "./substack-export.js";
import { docxDetector } from "./docx.js";
import { xlsxDetector } from "./xlsx.js";
import { pdfDetector } from "./pdf.js";
import { epubDetector } from "./epub.js";
import { githubRepoDetector } from "./github-repo.js";
import { markdownFolderDetector } from "./markdown-folder.js";
import { textFolderDetector } from "./text-folder.js";
import { plainHtmlDetector } from "./plain-html.js";
import { freestyleDetector } from "./freestyle.js";

/**
 * Ordering matters: detectors with stronger signals (explicit SSG
 * config files, platform-export fingerprints) should come first so
 * their higher `priority` breaks ties cleanly. The order below is
 * roughly "most specific → most generic".
 */
export const BUILT_IN_DETECTORS: Detector[] = [
  // Platform exports — strongest signals (unique XML / CSV layouts)
  wpWxrDetector,
  mediumExportDetector,
  substackExportDetector,
  // SSG frameworks with explicit config files
  docusaurusDetector,
  astroDetector,
  mkdocsDetector,
  hexoDetector,
  jekyllDetector,
  hugoDetector,
  eleventyDetector,
  gatsbyDetector,
  nextDetector,
  ghostDetector,
  // Binary / tabular document bundles
  docxDetector,
  xlsxDetector,
  pdfDetector,
  epubDetector,
  // Generic repos & text piles
  githubRepoDetector,
  plainHtmlDetector,
  markdownFolderDetector,
  textFolderDetector,
];

export { freestyleDetector };

/**
 * Pick the highest-confidence detector for the source. If none match above
 * the built-in threshold, the freestyle detector is used so that we never
 * skip a folder — we always produce a DetectedContext to migrate.
 */
export async function runDetectors(
  ctx: MigrationContext,
  bus: UiBus,
  threshold = 0.35,
): Promise<DetectorRunResult> {
  const scores: Array<{ detector: Detector; score: number }> = [];
  for (const d of BUILT_IN_DETECTORS) {
    try {
      const s = await d.match(ctx.sourceDir);
      if (s > 0) scores.push({ detector: d, score: s });
    } catch (err) {
      bus.pushStreamEvent("detect", {
        type: "warn",
        phase: "detect",
        message: `detector ${d.name} threw during match: ${(err as Error).message}`,
      });
    }
  }
  scores.sort(
    (a, b) => b.score - a.score || (b.detector.priority ?? 0) - (a.detector.priority ?? 0),
  );

  if (scores.length > 0) {
    const summary = scores
      .map((s) => `${s.detector.name}=${s.score.toFixed(2)}`)
      .join(" ");
    bus.pushStreamEvent("detect", {
      type: "info",
      phase: "detect",
      message: `detector scores: ${summary}`,
    });
  } else {
    bus.pushStreamEvent("detect", {
      type: "info",
      phase: "detect",
      message: "no built-in detector matched — falling back to freestyle",
    });
  }

  const winner = scores[0];
  if (winner && winner.score >= threshold) {
    bus.pushStreamEvent("detect", {
      type: "info",
      phase: "detect",
      message: `using ${winner.detector.name} detector (confidence ${winner.score.toFixed(2)})`,
    });
    const context = await winner.detector.detect(ctx, bus);
    return { context, usedDetector: winner.detector.name, ranFreestyle: false };
  }

  const context = await freestyleDetector.detect(ctx, bus);
  return { context, usedDetector: "freestyle", ranFreestyle: true };
}
