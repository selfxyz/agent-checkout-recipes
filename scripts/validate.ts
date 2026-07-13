// CLI: validate every recipe file and the registry-wide invariants.
// Usage: bun run scripts/validate.ts
import { loadRecipes } from "../src/registry";

try {
  const recipes = loadRecipes();
  const platforms = recipes.filter((r) => r.recipe.kind === "platform").length;
  console.log(`OK: ${platforms} platform + ${recipes.length - platforms} merchant recipes valid.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
