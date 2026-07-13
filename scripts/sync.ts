// Sync the registry into the Convex deployment's `checkoutRecipes` table so
// GET /v1/recipes serves it. Uses `bunx convex run`, so it authenticates like
// any other Convex CLI call (CONVEX_DEPLOYMENT/.env.local for dev, --prod or
// CONVEX_DEPLOY_KEY for production).
// Usage: bun run scripts/sync.ts [-- extra convex-run flags, e.g. --prod]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBundle, loadRecipes } from "../src/registry";

const ROOT = join(import.meta.dir, "..");
const version = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

const bundle = buildBundle(loadRecipes(), version);
const payload = {
  registryVersion: bundle.version,
  recipes: [...bundle.platforms, ...bundle.merchants].map((r) => ({
    key: r.id,
    kind: r.kind,
    platform: r.kind === "merchant" ? r.platform : undefined,
    hosts: r.kind === "merchant" ? r.hosts : undefined,
    status: r.status,
    // Drop any "$"-prefixed key (the editor-only $schema pointer, nested
    // $comment notes): "$"-prefixed field names are reserved in Convex values,
    // so a parsed body containing one can't be returned from a query.
    bodyJson: JSON.stringify(r, (k, v) => (k.startsWith("$") ? undefined : v)),
  })),
};

const extraArgs = process.argv.slice(2);
const proc = Bun.spawnSync(
  [
    "bunx",
    "convex",
    "run",
    "internal/recipes:internalSyncRecipes",
    JSON.stringify(payload),
    ...extraArgs,
  ],
  // Run from the repo root so the Convex CLI finds convex.json/.env.local.
  { cwd: join(ROOT, ".."), stdout: "inherit", stderr: "inherit" }
);
process.exit(proc.exitCode ?? 1);
