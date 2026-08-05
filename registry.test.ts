import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBundle, hostMatches, loadRecipes, recipesForUrl } from "./src/registry";
import { CARD_SURFACES, DEAD_END_TYPES, RECIPE_STATUSES } from "./src/types";
import type { MerchantRecipe, Recipe } from "./src/types";
import { clusterByStore, storeLabel, verifyMerge } from "./src/dedupe";
import { validateRecipe, validateRegistry } from "./src/validate";

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

  test("rejects a platform recipe with no detect signals", () => {
    expect(validateRecipe({ ...minimalPlatform, detect: {} }).errors.join(" ")).toContain(
      "at least one"
    );
  });

  test("rejects a merchant whose id is not one of its hosts", () => {
    expect(
      validateRecipe({
        id: "foo.com",
        kind: "merchant",
        hosts: ["bar.com"],
        platform: "custom",
        status: "unverified",
      }).errors.join(" ")
    ).toContain("must be one of its hosts");
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

describe("validateRegistry", () => {
  const merchant = (id: string, hosts: string[]): { file: string; recipe: Recipe } => ({
    file: `${id}.json`,
    recipe: {
      id,
      kind: "merchant",
      hosts,
      platform: "custom",
      status: "unverified",
    } as MerchantRecipe,
  });

  test("flags two recipes that claim a host and its www. alias", () => {
    const errs = validateRegistry([
      merchant("foo.com", ["foo.com"]),
      merchant("www", ["www.foo.com"]),
    ]);
    expect(errs.join(" ")).toMatch(/already claimed/);
  });

  test("accepts distinct hosts", () => {
    expect(validateRegistry([merchant("a.com", ["a.com"]), merchant("b.com", ["b.com"])])).toEqual(
      []
    );
  });

  test("rejects a platform recipe whose id is not an executable playbook", () => {
    const bad: { file: string; recipe: Recipe } = {
      file: "strpie-checkout.json",
      recipe: {
        id: "strpie-checkout",
        kind: "platform",
        name: "typo",
        status: "unverified",
        detect: { hosts: ["x.com"] },
        cardSurface: "direct-inputs",
        cvvTarget: "#c",
        steps: { payment: "p", placeOrder: "o", outcome: "s" },
      } as Recipe,
    };
    expect(validateRegistry([bad]).join(" ")).toMatch(/not an executable playbook/);
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
    // www and trailing-dot normalization
    expect(hostMatches("www.foo.com", "foo.com")).toBe(true);
    expect(hostMatches("foo.com.", "foo.com")).toBe(true);
    expect(hostMatches("www.foo.com", "www.foo.com")).toBe(true);
  });

  test("recipesForUrl matches a www. host to a bare-host merchant recipe", () => {
    const { merchant } = recipesForUrl(bundle, "https://www.brushespack.com/product/x");
    expect(merchant?.id).toBe("brushespack.com");
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

describe("duplicate detection", () => {
  test("storeLabel names the store, not the platform", () => {
    expect(storeLabel("sarahraedraws.gumroad.com")).toBe("sarahraedraws");
    expect(storeLabel("whileonearth.myshopify.com")).toBe("whileonearth");
    expect(storeLabel("onestopspiritualshoppe.company.site")).toBe("onestopspiritualshoppe");
    // Custom domains reduce to the label left of the public suffix...
    expect(storeLabel("shop.rufflesandrainboots.com")).toBe("rufflesandrainboots");
    expect(storeLabel("www.svgkingdom.com")).toBe("svgkingdom");
    expect(storeLabel("thing.co.uk")).toBe("thing");
    // ...and punctuation variants of one name collapse together.
    expect(storeLabel("ruffles-and-rainboots.com")).toBe("rufflesandrainboots");
  });

  const merchant = (id: string, hosts: string[], extra: Partial<MerchantRecipe> = {}) =>
    ({
      id,
      kind: "merchant",
      hosts,
      platform: "gumroad",
      status: "partial",
      ...extra,
    }) as MerchantRecipe;

  test("clusters a platform subdomain with the store's own domain", () => {
    const clusters = clusterByStore([
      merchant("sarahraedraws.gumroad.com", ["sarahraedraws.gumroad.com"]),
      merchant("sarahraedraws.com", ["sarahraedraws.com"]),
      merchant("svgkingdom.com", ["svgkingdom.com"]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.map((r) => r.id).sort()).toEqual([
      "sarahraedraws.com",
      "sarahraedraws.gumroad.com",
    ]);
  });

  test("overlapping labels collapse into one cluster, not two", () => {
    // A spans both labels. Emitted as [A,B] and [A,C], a --write run would merge
    // A into B and then overwrite that result merging A into C, losing B.
    const clusters = clusterByStore([
      merchant("store.com", ["store.com", "shop.gumroad.com"]),
      merchant("store.net", ["store.net"]),
      merchant("shop.com", ["shop.com"]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.map((r) => r.id).sort()).toEqual([
      "shop.com",
      "store.com",
      "store.net",
    ]);
  });

  test("confirmed-distinct pairs stop being reported", () => {
    const recipes = [
      merchant("foo.com", ["foo.com"]),
      merchant("foo.net", ["foo.net"]),
    ];
    expect(clusterByStore(recipes)).toHaveLength(1);
    expect(clusterByStore(recipes, [["foo.com", "foo.net"]])).toEqual([]);
    // A newcomer joining a known-distinct pair is still worth asking about.
    expect(
      clusterByStore([...recipes, merchant("foo.org", ["foo.org"])], [["foo.com", "foo.net"]])
    ).toHaveLength(1);
  });

  test("the live registry has no unreviewed duplicate candidates", () => {
    // A legitimate same-label pair is not a failure — record it in
    // recipes/distinct.json and this goes green again.
    const merchants = loadRecipes()
      .map((r) => r.recipe)
      .filter((r): r is MerchantRecipe => r.kind === "merchant");
    const { distinct } = JSON.parse(
      readFileSync(join(import.meta.dir, "recipes/distinct.json"), "utf8")
    ) as { distinct: string[][] };
    expect(clusterByStore(merchants, distinct).map((c) => c.map((r) => r.id))).toEqual([]);
  });

  describe("verifyMerge only accepts a merge built from its sources", () => {
    const sources = [
      merchant("a.gumroad.com", ["a.gumroad.com"], { notes: "Fixed-price digital product." }),
      merchant("a.com", ["a.com"], { notes: "Own domain fronts the same store." }),
    ];
    const good = {
      id: "a.com",
      kind: "merchant",
      hosts: ["a.com", "a.gumroad.com"],
      platform: "gumroad",
      status: "partial",
      notes: "Own domain fronts the same store.\nFixed-price digital product.",
    };

    test("accepts a faithful merge", () => {
      expect(verifyMerge(good, sources)).toEqual([]);
    });

    test("rejects prose the model wrote itself", () => {
      const errs = verifyMerge({ ...good, notes: "Great store, highly recommended!" }, sources);
      expect(errs.join(" ")).toContain("appears in no source recipe");
    });

    test("rejects hosts that are not the union", () => {
      expect(verifyMerge({ ...good, hosts: ["a.com"] }, sources).join(" ")).toContain("union");
    });

    test("rejects an id no source claimed", () => {
      const errs = verifyMerge({ ...good, id: "evil.com", hosts: ["a.com", "a.gumroad.com"] }, sources);
      expect(errs.join(" ")).toContain("not one of the source ids");
    });

    test("rejects a scalar no source carried", () => {
      expect(verifyMerge({ ...good, platform: "shopify" }, sources).join(" ")).toContain(
        "appears in no source recipe"
      );
    });

    test("refuses to merge a dead-end with a working recipe", () => {
      const conflicting = [
        sources[0]!,
        merchant("a.com", ["a.com"], {
          status: "dead-end",
          deadEnd: { type: "turnstile" },
        }),
      ];
      expect(verifyMerge(good, conflicting).join(" ")).toContain("needs a human");
    });

    test("rejects a merge that drops a source field", () => {
      // The source files are deleted after a merge, so an omitted field is not
      // a smaller recipe — it is data gone from the registry.
      const withUrl = [
        sources[0]!,
        merchant("a.com", ["a.com"], {
          notes: "Own domain fronts the same store.",
          exampleProductUrl: "https://a.com/l/x",
        }),
      ];
      expect(verifyMerge(good, withUrl).join(" ")).toContain(
        "exampleProductUrl is set in a source but missing from the merge"
      );
    });

    test("rejects a merge that drops a source override", () => {
      const withOverride = [
        sources[0]!,
        merchant("a.com", ["a.com"], {
          notes: "Own domain fronts the same store.",
          overrides: { placeOrder: "#buy" },
        }),
      ];
      expect(verifyMerge(good, withOverride).join(" ")).toContain(
        "overrides.placeOrder is set in a source but missing from the merge"
      );
    });

    test("rejects a merge that drops source prose", () => {
      const errs = verifyMerge({ ...good, notes: "Own domain fronts the same store." }, sources);
      expect(errs.join(" ")).toContain("source notes dropped by the merge");
    });

    test("refuses to merge sources that disagree on how checkout works", () => {
      const conflicting = [
        sources[0]!,
        merchant("a.com", ["a.com"], {
          notes: "Own domain fronts the same store.",
          platform: "shopify",
        }),
      ];
      expect(verifyMerge(good, conflicting).join(" ")).toContain("sources disagree on platform");
    });

    test("rejects prose moved between fields", () => {
      // Words surviving somewhere is not enough: `evidence` relocated into
      // `notes` still loses the structured field consumers read.
      const withEvidence = [
        sources[0]!,
        merchant("a.com", ["a.com"], {
          notes: "Own domain fronts the same store.",
          evidence: "Order #123, email receipt.",
        }),
      ];
      const moved = {
        ...good,
        notes: "Own domain fronts the same store.\nFixed-price digital product.\nOrder #123, email receipt.",
      };
      const errs = verifyMerge(moved, withEvidence).join(" ");
      expect(errs).toContain("source evidence dropped by the merge");
      expect(errs).toContain("appears in no source recipe's notes");
    });

    test("refuses to merge dead-ends blocked for different reasons", () => {
      const conflicting = [
        merchant("a.gumroad.com", ["a.gumroad.com"], {
          status: "dead-end",
          deadEnd: { type: "captcha" },
        }),
        merchant("a.com", ["a.com"], {
          status: "dead-end",
          deadEnd: { type: "paypal-only" },
        }),
      ];
      const m = {
        ...good,
        status: "dead-end",
        deadEnd: { type: "captcha" },
        notes: undefined,
      };
      expect(verifyMerge(m, conflicting).join(" ")).toContain("sources disagree on deadEnd.type");
    });

    test("rejects unknown keys", () => {
      expect(verifyMerge({ ...good, script: "x" }, sources).join(" ")).toContain("unknown key");
    });
  });
});
