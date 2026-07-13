// Load and query the recipe files. Used by the build/sync scripts, the
// benchmark, and the tests.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MerchantRecipe, PlatformRecipe, Recipe, RegistryBundle } from "./types";
import { validateRecipe, validateRegistry } from "./validate";

const ROOT = join(import.meta.dir, "..");

export interface LoadedRecipe {
  file: string; // path relative to the registry root
  recipe: Recipe;
}

// Read every recipe under recipes/, validating each file and the registry-wide
// invariants. Throws with a readable list of problems on any failure — loaders
// must never hand out a half-valid registry.
export function loadRecipes(root = ROOT): LoadedRecipe[] {
  const out: LoadedRecipe[] = [];
  const problems: string[] = [];
  for (const dir of ["recipes/platforms", "recipes/merchants"]) {
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = `${dir}/${name}`;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(root, file), "utf8"));
      } catch (e) {
        problems.push(`${file}: invalid JSON (${(e as Error).message})`);
        continue;
      }
      const { recipe, errors } = validateRecipe(raw);
      if (!recipe) {
        problems.push(...errors.map((e) => `${file}: ${e}`));
        continue;
      }
      const expectedKind = dir.includes("platforms") ? "platform" : "merchant";
      if (recipe.kind !== expectedKind)
        problems.push(`${file}: kind "${recipe.kind}" does not belong in ${dir}`);
      if (`${recipe.id}.json` !== name)
        problems.push(`${file}: filename must be "<id>.json" (id is "${recipe.id}")`);
      out.push({ file, recipe });
    }
  }
  problems.push(...validateRegistry(out));
  if (problems.length) {
    throw new Error(`registry validation failed:\n  ${problems.join("\n  ")}`);
  }
  return out;
}

export function buildBundle(recipes: LoadedRecipe[], version: string): RegistryBundle {
  return {
    version,
    generatedAt: new Date().toISOString(),
    platforms: recipes
      .map((r) => r.recipe)
      .filter((r): r is PlatformRecipe => r.kind === "platform"),
    merchants: recipes
      .map((r) => r.recipe)
      .filter((r): r is MerchantRecipe => r.kind === "merchant"),
  };
}

// Normalize a host: lowercase, drop a trailing dot and a leading "www." so
// www.foo.com matches the foo.com recipe (mirrors the proxy/token lookup and
// convex/internal/recipes.ts).
function normHost(h: string): string {
  return h
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

// True when `host` is `pattern` or a subdomain of it ("shop.foo.com" and
// "www.foo.com" both match "foo.com" and "*.foo.com").
export function hostMatches(host: string, pattern: string): boolean {
  const h = normHost(host);
  const p = normHost(pattern.replace(/^\*\./, ""));
  return h === p || h.endsWith(`.${p}`);
}

// Find the recipes that apply to a page URL: the merchant recipe whose host
// matches (most specific wins), plus the platform recipe it names — or, with no
// merchant match, any platform recipe whose detect.hosts/urlPatterns match.
export function recipesForUrl(
  bundle: RegistryBundle,
  url: string
): { merchant?: MerchantRecipe; platform?: PlatformRecipe } {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return {};
  }

  const merchant = bundle.merchants
    .filter((m) => m.hosts.some((h) => hostMatches(host, h)))
    // Most specific claim wins (longest matching host pattern).
    .sort((a, b) => longestMatch(b, host) - longestMatch(a, host))[0];

  // "custom" is not an executable platform (the merchant opted out), so it names
  // no platform recipe and must NOT fall through to fingerprint inference.
  const platformId =
    merchant?.platform && merchant.platform !== "custom" ? merchant.platform : undefined;
  let platform = platformId ? bundle.platforms.find((p) => p.id === platformId) : undefined;

  // Infer a platform from URL fingerprints only when NO merchant matched — a
  // matched merchant (including a "custom" one) is authoritative for its host.
  if (!platform && !merchant) {
    platform = bundle.platforms.find(
      (p) =>
        (p.detect.hosts ?? []).some((h) => hostMatches(host, h)) ||
        (p.detect.urlPatterns ?? []).some((re) => {
          try {
            return new RegExp(re, "i").test(url);
          } catch {
            return false;
          }
        })
    );
  }
  return { merchant, platform };
}

function longestMatch(m: MerchantRecipe, host: string): number {
  return Math.max(...m.hosts.filter((h) => hostMatches(host, h)).map((h) => h.length), 0);
}
