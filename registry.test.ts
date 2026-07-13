import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBundle, hostMatches, loadRecipes, recipesForUrl } from "./src/registry";
import { CARD_SURFACES, DEAD_END_TYPES, RECIPE_STATUSES } from "./src/types";
import { validateRecipe } from "./src/validate";

describe("recipe files", () => {
  test("every recipe file validates and registry invariants hold", () => {
    // loadRecipes throws with the full problem list on any violation.
    const recipes = loadRecipes();
    expect(recipes.length).toBeGreaterThan(0);
  });

  test("the 14 campaign platforms are present", () => {
    const ids = loadRecipes()
      .filter((r) => r.recipe.kind === "platform")
      .map((r) => r.recipe.id)
      .sort();
    expect(ids).toEqual(
      [
        "bigcartel",
        "bigcommerce",
        "ecwid",
        "fastspring",
        "gumroad",
        "lemonsqueezy",
        "paddle",
        "shopify",
        "snipcart",
        "squarespace",
        "stripe-checkout",
        "stripe-payment-link",
        "wix",
        "woocommerce",
      ].sort()
    );
  });
});

describe("validateRecipe", () => {
  const minimalPlatform = {
    id: "example",
    kind: "platform",
    name: "Example",
    status: "unverified",
    detect: { hosts: ["example.com"] },
    cardSurface: "direct-inputs",
    cvvTarget: "#cvc",
    steps: { payment: "p", placeOrder: "o", outcome: "s" },
  };

  test("accepts a minimal platform recipe", () => {
    expect(validateRecipe(minimalPlatform).errors).toEqual([]);
  });

  test("rejects verified without evidence", () => {
    const { errors } = validateRecipe({ ...minimalPlatform, status: "verified" });
    expect(errors.join(" ")).toContain("evidence");
  });

  test("rejects a dead-end merchant without a deadEnd object (and vice versa)", () => {
    const merchant = {
      id: "shop.example.com",
      kind: "merchant",
      hosts: ["shop.example.com"],
      platform: "custom",
      status: "dead-end",
    };
    expect(validateRecipe(merchant).errors.join(" ")).toContain("deadEnd");
    expect(
      validateRecipe({
        ...merchant,
        status: "unverified",
        deadEnd: { type: "turnstile" },
      }).errors.join(" ")
    ).toContain('status "dead-end"');
  });

  test("rejects invalid detect regexes and wildcard merchant hosts", () => {
    expect(
      validateRecipe({
        ...minimalPlatform,
        detect: { urlPatterns: ["("] },
      }).errors.join(" ")
    ).toContain("invalid regex");
    expect(
      validateRecipe({
        id: "x.example.com",
        kind: "merchant",
        hosts: ["*.example.com"],
        platform: "custom",
        status: "unverified",
      }).errors.join(" ")
    ).toContain("hosts");
  });
});

describe("lookup", () => {
  const bundle = buildBundle(loadRecipes(), "test");

  test("hostMatches handles exact, subdomain, and wildcard patterns", () => {
    expect(hostMatches("foo.com", "foo.com")).toBe(true);
    expect(hostMatches("shop.foo.com", "foo.com")).toBe(true);
    expect(hostMatches("shop.foo.com", "*.foo.com")).toBe(true);
    expect(hostMatches("notfoo.com", "foo.com")).toBe(false);
    expect(hostMatches("foo.com.evil.com", "foo.com")).toBe(false);
  });

  test("merchant recipe wins and pulls its platform recipe", () => {
    const { merchant, platform } = recipesForUrl(bundle, "https://brushespack.com/product/x");
    expect(merchant?.id).toBe("brushespack.com");
    expect(platform?.id).toBe("woocommerce");
  });

  test("platform detect.hosts match when no merchant recipe exists", () => {
    const { merchant, platform } = recipesForUrl(bundle, "https://randomstore.myshopify.com/");
    expect(merchant).toBeUndefined();
    expect(platform?.id).toBe("shopify");
  });

  test("subdomain-specific merchant beats a broader host claim", () => {
    const { merchant } = recipesForUrl(bundle, "https://thuecast.itch.io/somegame");
    expect(merchant?.id).toBe("thuecast.itch.io");
  });

  test("unknown url returns nothing", () => {
    expect(recipesForUrl(bundle, "https://never-heard-of-it.example")).toEqual({
      merchant: undefined,
      platform: undefined,
    });
    expect(recipesForUrl(bundle, "not a url")).toEqual({});
  });
});

describe("schema/recipe.schema.json stays in sync with types.ts", () => {
  const schema = JSON.parse(
    readFileSync(join(import.meta.dir, "schema/recipe.schema.json"), "utf8")
  ) as {
    definitions: {
      status: { enum: string[] };
      cardSurface: { enum: string[] };
      deadEndType: { enum: string[] };
    };
  };

  test("enums match", () => {
    expect(schema.definitions.status.enum).toEqual([...RECIPE_STATUSES]);
    expect(schema.definitions.cardSurface.enum).toEqual([...CARD_SURFACES]);
    expect(schema.definitions.deadEndType.enum).toEqual([...DEAD_END_TYPES]);
  });
});
