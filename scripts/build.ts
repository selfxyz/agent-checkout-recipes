// Build the distributable artifacts from the recipe files:
//   dist/registry.json — the full RegistryBundle (what downstreams consume)
//   dist/RECIPES.md    — one aggregated, agent-readable document of every recipe
// Usage: bun run scripts/build.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBundle, loadRecipes } from "../src/registry";
import type { MerchantRecipe, PlatformRecipe } from "../src/types";

const ROOT = join(import.meta.dir, "..");
const version = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

const recipes = loadRecipes();
const bundle = buildBundle(recipes, version);

mkdirSync(join(ROOT, "dist"), { recursive: true });
writeFileSync(join(ROOT, "dist/registry.json"), `${JSON.stringify(bundle, null, 2)}\n`);

function mdPlatform(p: PlatformRecipe): string {
  const lines = [
    `### ${p.name} (\`${p.id}\`) — ${p.status}`,
    "",
    ...(p.notes ? [p.notes, ""] : []),
    `- **Detect:** ${[
      ...(p.detect.hosts ?? []).map((h) => `host \`${h}\``),
      ...(p.detect.urlPatterns ?? []).map((u) => `url \`${u}\``),
      ...(p.detect.selectors ?? []).map((s) => `\`${s}\``),
    ].join(", ")}`,
    `- **Card surface:** ${p.cardSurface}; CVV token → \`${p.cvvTarget}\``,
  ];
  for (const [key, label] of [
    ["addToCart", "Add to cart"],
    ["contact", "Contact"],
    ["billing", "Billing"],
    ["payment", "Payment"],
    ["placeOrder", "Place order"],
    ["outcome", "Outcome"],
  ] as const) {
    const v = p.steps[key];
    if (v) lines.push(`- **${label}:** ${v}`);
  }
  if (p.gotchas?.length) {
    lines.push("- **Gotchas:**", ...p.gotchas.map((g) => `  - ${g}`));
  }
  return lines.join("\n");
}

function mdMerchant(m: MerchantRecipe): string {
  const lines = [
    `### ${m.id} — ${m.status}${m.platform !== "custom" ? ` (platform: ${m.platform})` : ""}`,
  ];
  if (m.deadEnd) lines.push(`- **DEAD-END (${m.deadEnd.type}):** ${m.deadEnd.details ?? ""}`);
  if (m.evidence) lines.push(`- **Evidence:** ${m.evidence}`);
  if (m.overrides && Object.keys(m.overrides).length)
    lines.push(
      `- **Overrides:** ${Object.entries(m.overrides)
        .map(([k, v]) => `${k} → \`${v}\``)
        .join("; ")}`
    );
  if (m.exampleProductUrl) lines.push(`- **Example product:** ${m.exampleProductUrl}`);
  if (m.gotchas?.length) lines.push("- **Gotchas:**", ...m.gotchas.map((g) => `  - ${g}`));
  if (m.notes) lines.push(`- ${m.notes}`);
  return lines.join("\n");
}

const md = [
  "# Checkout recipes (aggregated)",
  "",
  `_Generated from the registry (v${version}) — do not edit; edit the JSON files under recipes/ instead._`,
  "",
  "Every value you fill is an Agent Vault **mock token**; the proxy substitutes",
  "the real value. Fill order on card steps: everything else, then the card-number",
  "token, then the CVV token **immediately** after. On any detected challenge",
  "(3DS/OTP/CAPTCHA), stop and hand off to the human — never solve or guess.",
  "",
  "## Platforms",
  "",
  bundle.platforms.map(mdPlatform).join("\n\n"),
  "",
  "## Merchants",
  "",
  bundle.merchants.map(mdMerchant).join("\n\n"),
  "",
].join("\n");

writeFileSync(join(ROOT, "dist/RECIPES.md"), md);
console.log(
  `Built dist/registry.json + dist/RECIPES.md (${bundle.platforms.length} platforms, ${bundle.merchants.length} merchants).`
);
