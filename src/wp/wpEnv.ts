import { execa } from "execa";
import { writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface WpEnvConfigOptions {
  sourceDir: string;
  themeDir: string;
  pluginDir: string;
  workDir: string;
  siteTitle?: string;
  phpVersion?: string;
  wpVersion?: string;
  port?: number;
}

export const WORK_MOUNT = "wp-content/to-wordpress";

/**
 * Build a .wp-env.json configuration that mounts the generated theme and
 * plugin into wp-content, and the working WORDPRESS_MIGRATION directory at
 * wp-content/to-wordpress so `wp eval-file` can read import manifests.
 */
export function buildWpEnvConfig(opts: WpEnvConfigOptions): Record<string, unknown> {
  const rel = (p: string) => "./" + relative(opts.sourceDir, p).replaceAll("\\", "/");
  const themeRel = rel(opts.themeDir);
  const pluginRel = rel(opts.pluginDir);
  const workRel = rel(opts.workDir);
  const config: Record<string, unknown> = {
    core: opts.wpVersion ? `WordPress/WordPress#${opts.wpVersion}` : null,
    phpVersion: opts.phpVersion ?? "8.2",
    themes: [themeRel],
    plugins: [pluginRel],
    mappings: {
      [WORK_MOUNT]: workRel,
    },
    port: opts.port ?? 8888,
    config: {
      WP_DEBUG: true,
      WP_DEBUG_LOG: true,
    },
  };
  return config;
}

export async function writeWpEnvConfig(path: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export interface WpEnvRunOptions {
  cwd: string;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  timeoutMs?: number;
}

async function runWpEnv(args: string[], opts: WpEnvRunOptions): Promise<number> {
  const child = execa("npx", ["--yes", "@wordpress/env", ...args], {
    cwd: opts.cwd,
    reject: false,
    buffer: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 10 * 60 * 1000,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  pumpToLines(child.stdout!, (l) => opts.onLine?.(l, "stdout"));
  pumpToLines(child.stderr!, (l) => opts.onLine?.(l, "stderr"));
  const res = await child;
  return res.exitCode ?? 0;
}

export function wpEnvStart(opts: WpEnvRunOptions): Promise<number> {
  return runWpEnv(["start"], opts);
}

export function wpEnvStop(opts: WpEnvRunOptions): Promise<number> {
  return runWpEnv(["stop"], opts);
}

export function wpEnvDestroy(opts: WpEnvRunOptions): Promise<number> {
  return runWpEnv(["destroy", "--scripts=false"], opts);
}

export interface WpCliOptions extends WpEnvRunOptions {
  env?: "development" | "tests";
}

/**
 * Run a wp-cli command against the wp-env dev instance. Returns exit code and
 * captured stdout for parsing.
 */
export async function wpCli(
  args: string[],
  opts: WpCliOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const baseArgs = ["--yes", "@wordpress/env", "run"];
  const envName = opts.env ?? "cli";
  const serviceArgs = opts.env === "tests" ? ["tests-cli"] : [envName === "development" ? "cli" : envName];
  const child = execa(
    "npx",
    [...baseArgs, ...serviceArgs, "wp", ...args],
    {
      cwd: opts.cwd,
      reject: false,
      buffer: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs ?? 5 * 60 * 1000,
      env: { ...process.env, FORCE_COLOR: "0" },
    },
  );
  let stdout = "";
  let stderr = "";
  pumpToLines(child.stdout!, (l) => {
    stdout += l + "\n";
    opts.onLine?.(l, "stdout");
  });
  pumpToLines(child.stderr!, (l) => {
    stderr += l + "\n";
    opts.onLine?.(l, "stderr");
  });
  const res = await child;
  return { exitCode: res.exitCode ?? 0, stdout, stderr };
}

async function pumpToLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): Promise<void> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  }
  const rest = buffer.trim();
  if (rest.length > 0) onLine(rest);
}

export function resolveTheme(paths: { sourceDir: string; themeDir: string }): string {
  return resolve(paths.sourceDir, paths.themeDir);
}
