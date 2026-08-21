// The skill is the front door of this repo — keep it honest. These tests pin
// the SKILL.md to the registry it describes: real frontmatter, real endpoints,
// real platform ids, and claims that match the schema.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const skillDir = join(import.meta.dir, "skills", "checkout-recipes");
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");

function frontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("no frontmatter");
  const out: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

describe("skill", () => {
  test("has installable frontmatter whose name matches its directory", () => {
    const fm = frontmatter(skill);
    expect(fm.name).toBe("checkout-recipes");
    const description = fm.description ?? "";
    expect(description.length).toBeGreaterThan(80);
    // The description is what triggers auto-invocation — it must say when.
    expect(description.toLowerCase()).toContain("checkout");
    expect(description.toLowerCase()).toContain("buy");
  });

  test("stays small enough to sit in a context window", () => {
    expect(skill.length).toBeLessThan(8_000);
  });

  test("points at the same API base as the README", () => {
    const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8");
    const base = skill.match(/https:\/\/[a-z0-9-]+\.convex\.site/)?.[0];
    expect(base).toBeTruthy();
    expect(readme).toContain(base!);
  });

  test("every platform it name-drops exists in recipes/platforms", () => {
    const platforms = new Set(
      readdirSync(join(import.meta.dir, "recipes", "platforms")).map((f) =>
        f.replace(/\.json$/, ""),
      ),
    );
    for (const p of ["shopify", "woocommerce", "gumroad", "lemonsqueezy"]) {
      expect(platforms.has(p)).toBe(true);
    }
  });

  test("only lets contributors claim statuses the guard accepts", () => {
    // The skill must never teach an agent to claim `verified` — that is
    // maintainer-gated behind verificationRequested.
    const claim = skill.match(/`status` you may claim: (.*)/)?.[1] ?? "";
    expect(claim).toContain("partial");
    expect(claim).toContain("dead-end");
    expect(claim).not.toContain("`verified`");
    expect(skill).toContain("verificationRequested");
  });

  test("its raw-GitHub fallback paths exist in this repo", () => {
    const paths = [...skill.matchAll(/raw\.githubusercontent\.com\/selfxyz\/agent-checkout-recipes\/main\/([\w/.-]+)/g)];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      // Strip the <host>.json placeholder segment down to its real directory.
      const real = (p[1] ?? "").replace(/\/$/, "");
      expect(existsSync(join(import.meta.dir, real))).toBe(true);
    }
  });

  test("merchant files really are named by primary host, as the fallback claims", () => {
    for (const f of readdirSync(join(import.meta.dir, "recipes", "merchants"))) {
      const recipe = JSON.parse(
        readFileSync(join(import.meta.dir, "recipes", "merchants", f), "utf8"),
      ) as { id: string; hosts: string[] };
      expect(f).toBe(`${recipe.id}.json`);
      expect(recipe.hosts[0]).toBe(recipe.id);
    }
  });
});

// Live smoke — only with LIVE=1 so CI stays hermetic. Proves the URL the skill
// hardcodes actually answers with the documented shape.
describe.if(!!process.env.LIVE)("live API", () => {
  const base = skill.match(/https:\/\/[a-z0-9-]+\.convex\.site/)![0];

  test("serves the coverage index", async () => {
    const res = await fetch(`${base}/v1/recipes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recipes: { key: string; kind: string }[] };
    expect(body.recipes.length).toBeGreaterThan(20);
  });

  test("resolves a URL to merchant + platform recipes", async () => {
    const res = await fetch(`${base}/v1/recipes?url=${encodeURIComponent("https://brushespack.com/shop/x")}`);
    const body = (await res.json()) as { merchant: any; platform: any };
    expect(body.merchant?.id).toBe("brushespack.com");
    expect(body.platform?.id).toBe("woocommerce");
  });
});
