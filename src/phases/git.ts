import { execa } from "execa";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function git(ctx: MigrationContext, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  const res = await execa("git", args, {
    cwd: ctx.sourceDir,
    reject: false,
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    exitCode: res.exitCode ?? 0,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

/**
 * A directory counts as "a repo" for our purposes only when its OWN root is
 * the git top-level. If the dir is nested inside somebody else's checkout
 * (e.g. a fixture inside the towp monorepo) we treat it as a fresh folder
 * so we don't accidentally commit to the outer repo.
 */
async function isOwnRepo(ctx: MigrationContext): Promise<boolean> {
  if (existsSync(join(ctx.sourceDir, ".git"))) return true;
  const inside = await git(ctx, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return false;
  const top = await git(ctx, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) return false;
  return resolve(top.stdout.trim()) === resolve(ctx.sourceDir);
}

async function ensureUserIdentity(ctx: MigrationContext, bus: UiBus): Promise<void> {
  const name = await git(ctx, ["config", "--get", "user.name"]);
  const email = await git(ctx, ["config", "--get", "user.email"]);
  if (name.exitCode === 0 && email.exitCode === 0 && name.stdout.trim() && email.stdout.trim()) return;
  bus.pushStreamEvent(undefined, {
    type: "info",
    phase: "detect",
    message: "git: no user identity configured — setting a local one for this repo only",
  });
  if (name.exitCode !== 0 || !name.stdout.trim()) {
    await git(ctx, ["config", "--local", "user.name", "to-wordpress"]);
  }
  if (email.exitCode !== 0 || !email.stdout.trim()) {
    await git(ctx, ["config", "--local", "user.email", "noreply@to-wordpress.local"]);
  }
}

/**
 * Set up version control around the source site so every phase's output is
 * committed on a dedicated branch. Works for both already-tracked repos
 * (creates + switches to the branch) and fresh folders (runs `git init`).
 * Refuses to operate on a dir that is nested inside some other repo — in
 * that case git setup is skipped entirely to avoid accidental commits.
 */
export async function setupGit(
  ctx: MigrationContext,
  bus: UiBus,
  branch: string,
): Promise<{ branch: string; active: boolean }> {
  const ownRepo = await isOwnRepo(ctx);

  if (!ownRepo) {
    const insideAnother = (await git(ctx, ["rev-parse", "--is-inside-work-tree"])).exitCode === 0;
    if (insideAnother) {
      bus.pushStreamEvent(undefined, {
        type: "warn",
        phase: "detect",
        message: "git: source is nested inside another git repo — skipping auto git setup (pass --no-git to silence)",
      });
      return { branch, active: false };
    }
    bus.pushStreamEvent(undefined, {
      type: "info",
      phase: "detect",
      message: "git: source is not a repo — running `git init`",
    });
    const init = await git(ctx, ["init", "-b", "main"]);
    if (init.exitCode !== 0) {
      bus.pushStreamEvent(undefined, {
        type: "warn",
        phase: "detect",
        message: `git init failed: ${init.stderr || init.stdout}`,
      });
      return { branch, active: false };
    }
  }

  await ensureUserIdentity(ctx, bus);

  // Capture any pre-existing state as a pinned baseline before branching so
  // we can always diff "towp's work" against "the user's starting point".
  await git(ctx, ["add", "-A"]);
  const preStatus = await git(ctx, ["status", "--porcelain"]);
  if (preStatus.stdout.trim()) {
    const preCommit = await git(ctx, ["commit", "-m", "towp: pre-migration snapshot"]);
    if (preCommit.exitCode === 0) {
      bus.pushStreamEvent(undefined, {
        type: "info",
        phase: "detect",
        message: "git: committed pre-migration snapshot",
      });
    }
  }

  const exists = await git(ctx, ["rev-parse", "--verify", "--quiet", branch]);
  if (exists.exitCode === 0) {
    await git(ctx, ["checkout", branch]);
    bus.pushStreamEvent(undefined, {
      type: "info",
      phase: "detect",
      message: `git: switched to existing branch '${branch}'`,
    });
  } else {
    const headOk = await git(ctx, ["rev-parse", "--verify", "HEAD"]);
    if (headOk.exitCode !== 0) {
      await git(ctx, ["commit", "--allow-empty", "-m", "towp: empty root"]);
    }
    await git(ctx, ["checkout", "-b", branch]);
    bus.pushStreamEvent(undefined, {
      type: "info",
      phase: "detect",
      message: `git: created and switched to branch '${branch}'`,
    });
  }

  return { branch, active: true };
}

export interface CommitState {
  active: boolean;
}

/**
 * Stage every change in the source tree and create a commit. No-ops when
 * there is nothing staged (so repeated phases don't produce empty commits).
 */
export async function commitPhase(
  ctx: MigrationContext,
  phaseLabel: string,
  bus: UiBus,
  state: CommitState,
): Promise<void> {
  if (!state.active) return;
  await git(ctx, ["add", "-A"]);
  const status = await git(ctx, ["status", "--porcelain"]);
  if (!status.stdout.trim()) return;
  const msg = `towp: ${phaseLabel}`;
  const commit = await git(ctx, ["commit", "-m", msg]);
  if (commit.exitCode === 0) {
    const sha = (await git(ctx, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    bus.pushStreamEvent(undefined, {
      type: "info",
      phase: "detect",
      message: `git: committed ${sha} "${msg}"`,
    });
  } else {
    bus.pushStreamEvent(undefined, {
      type: "warn",
      phase: "detect",
      message: `git commit failed for ${phaseLabel}: ${commit.stderr || commit.stdout}`,
    });
  }
}
