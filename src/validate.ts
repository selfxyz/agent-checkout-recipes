// Structural validator for registry recipes. Deliberately dependency-free: the
// TS types in types.ts are the source of truth, this enforces them at runtime,
// and schema/recipe.schema.json mirrors them for editors (a test keeps the
// enums in sync).
import {
  CARD_SURFACES,
  DEAD_END_TYPES,
  type MerchantRecipe,
  type PlatformRecipe,
  RECIPE_STATUSES,
  type Recipe,
} from "./types";

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A registrable host: dot-separated labels, optionally led by "*." (wildcard).
const HOST_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

type Errors = string[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkStringArray(errs: Errors, where: string, v: unknown, opts: { re?: RegExp } = {}) {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s.length === 0)) {
    errs.push(`${where}: must be an array of non-empty strings`);
    return;
  }
  if (opts.re) {
    for (const s of v as string[]) {
      if (!opts.re.test(s)) errs.push(`${where}: "${s}" does not match ${opts.re}`);
    }
  }
}

function checkOptionalString(errs: Errors, where: string, v: unknown, re?: RegExp) {
  if (v === undefined) return;
  if (typeof v !== "string" || v.length === 0) {
    errs.push(`${where}: must be a non-empty string`);
    return;
  }
  if (re && !re.test(v)) errs.push(`${where}: "${v}" does not match ${re}`);
}

function checkSelectorMap(errs: Errors, where: string, v: unknown, allowArrays: boolean) {
  if (v === undefined) return;
  if (!isRecord(v)) {
    errs.push(`${where}: must be an object`);
    return;
  }
  for (const [k, val] of Object.entries(v)) {
    const ok =
      (typeof val === "string" && val.length > 0) ||
      (allowArrays &&
        Array.isArray(val) &&
        val.length > 0 &&
        val.every((s) => typeof s === "string" && s.length > 0));
    if (!ok)
      errs.push(
        `${where}.${k}: must be a non-empty selector string${allowArrays ? " or array of them" : ""}`
      );
  }
}

function checkBase(errs: Errors, r: Record<string, unknown>) {
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) {
    errs.push(`id: must match ${ID_RE} (got ${JSON.stringify(r.id)})`);
  }
  if (!RECIPE_STATUSES.includes(r.status as never)) {
    errs.push(`status: must be one of ${RECIPE_STATUSES.join(", ")}`);
  }
  checkOptionalString(errs, "lastVerifiedAt", r.lastVerifiedAt, DATE_RE);
  checkOptionalString(errs, "evidence", r.evidence);
  checkOptionalString(errs, "notes", r.notes);
  checkStringArray(errs, "gotchas", r.gotchas);
  // A "verified" claim without evidence is unauditable — require the trail.
  if (r.status === "verified") {
    if (!r.evidence) errs.push(`status "verified" requires evidence`);
    if (!r.lastVerifiedAt) errs.push(`status "verified" requires lastVerifiedAt`);
  }
}

function checkSteps(errs: Errors, v: unknown) {
  if (!isRecord(v)) {
    errs.push("steps: must be an object");
    return;
  }
  for (const key of ["payment", "placeOrder", "outcome"]) {
    if (typeof v[key] !== "string" || v[key].length === 0)
      errs.push(`steps.${key}: required non-empty string`);
  }
  for (const key of ["addToCart", "contact", "billing"])
    checkOptionalString(errs, `steps.${key}`, v[key]);
}

export function validateRecipe(raw: unknown): { recipe?: Recipe; errors: Errors } {
  const errs: Errors = [];
  if (!isRecord(raw)) return { errors: ["recipe must be a JSON object"] };
  checkBase(errs, raw);

  if (raw.kind === "platform") {
    if (typeof raw.name !== "string" || raw.name.length === 0)
      errs.push("name: required non-empty string");
    if (!isRecord(raw.detect)) {
      errs.push("detect: must be an object");
    } else {
      checkStringArray(errs, "detect.hosts", raw.detect.hosts, { re: HOST_RE });
      checkStringArray(errs, "detect.urlPatterns", raw.detect.urlPatterns);
      checkStringArray(errs, "detect.selectors", raw.detect.selectors);
      for (const p of (raw.detect.urlPatterns as string[] | undefined) ?? []) {
        try {
          new RegExp(p);
        } catch {
          errs.push(`detect.urlPatterns: invalid regex "${p}"`);
        }
      }
    }
    if (!CARD_SURFACES.includes(raw.cardSurface as never))
      errs.push(`cardSurface: must be one of ${CARD_SURFACES.join(", ")}`);
    if (typeof raw.cvvTarget !== "string" || raw.cvvTarget.length === 0)
      errs.push("cvvTarget: required non-empty string");
    checkSteps(errs, raw.steps);
    checkSelectorMap(errs, "selectors", raw.selectors, true);
    return errs.length
      ? { errors: errs }
      : { recipe: raw as unknown as PlatformRecipe, errors: [] };
  }

  if (raw.kind === "merchant") {
    if (
      !Array.isArray(raw.hosts) ||
      raw.hosts.length === 0 ||
      raw.hosts.some((h) => typeof h !== "string" || !HOST_RE.test(h) || h.startsWith("*."))
    ) {
      errs.push("hosts: required array of concrete hosts (no wildcards)");
    }
    if (typeof raw.platform !== "string" || raw.platform.length === 0)
      errs.push("platform: required non-empty string (a platform recipe id or 'custom')");
    if (raw.cardSurface !== undefined && !CARD_SURFACES.includes(raw.cardSurface as never))
      errs.push(`cardSurface: must be one of ${CARD_SURFACES.join(", ")}`);
    checkOptionalString(errs, "cvvTarget", raw.cvvTarget);
    checkSelectorMap(errs, "overrides", raw.overrides, false);
    checkOptionalString(errs, "exampleProductUrl", raw.exampleProductUrl);
    if (typeof raw.exampleProductUrl === "string") {
      try {
        const u = new URL(raw.exampleProductUrl);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad protocol");
      } catch {
        errs.push("exampleProductUrl: not a valid http(s) URL");
      }
    }
    if (raw.deadEnd !== undefined) {
      if (!isRecord(raw.deadEnd) || !DEAD_END_TYPES.includes(raw.deadEnd.type as never)) {
        errs.push(`deadEnd.type: must be one of ${DEAD_END_TYPES.join(", ")}`);
      } else {
        checkOptionalString(errs, "deadEnd.details", raw.deadEnd.details);
      }
      // A dead-end merchant must say so in status too, so consumers can filter
      // on one field.
      if (raw.status !== "dead-end") errs.push(`deadEnd present requires status "dead-end"`);
    } else if (raw.status === "dead-end") {
      errs.push(`status "dead-end" requires a deadEnd object explaining why`);
    }
    return errs.length
      ? { errors: errs }
      : { recipe: raw as unknown as MerchantRecipe, errors: [] };
  }

  return { errors: [`kind: must be "platform" or "merchant"`] };
}

// Cross-recipe checks over the whole registry.
export function validateRegistry(recipes: { file: string; recipe: Recipe }[]): Errors {
  const errs: Errors = [];
  const ids = new Map<string, string>();
  const hostOwners = new Map<string, string>();
  const platformIds = new Set(
    recipes.filter((r) => r.recipe.kind === "platform").map((r) => r.recipe.id)
  );

  for (const { file, recipe } of recipes) {
    const prior = ids.get(recipe.id);
    if (prior) errs.push(`${file}: duplicate id "${recipe.id}" (also in ${prior})`);
    ids.set(recipe.id, file);

    if (recipe.kind === "merchant") {
      if (recipe.platform !== "custom" && !platformIds.has(recipe.platform)) {
        errs.push(`${file}: platform "${recipe.platform}" has no platform recipe`);
      }
      for (const host of recipe.hosts) {
        // Key by the NORMALIZED host (lookup strips a leading "www." and a
        // trailing dot), so `foo.com` and `www.foo.com` can't both be claimed —
        // they'd match the same lookups and the longer one could shadow the other.
        const key = host
          .toLowerCase()
          .replace(/\.$/, "")
          .replace(/^www\./, "");
        const owner = hostOwners.get(key);
        if (owner)
          errs.push(`${file}: host "${host}" (normalized "${key}") already claimed by ${owner}`);
        hostOwners.set(key, file);
      }
    }
  }
  return errs;
}
