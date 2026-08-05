// Near-duplicate detection and merge verification for merchant recipes.
//
// Two recipes can describe the SAME store under cosmetically different hosts
// ("sarahraedraws.gumroad.com" vs "sarahraedraws.com"), which the exact-host
// collision check in validate.ts cannot see — the hosts genuinely differ.
//
// Clustering here is deterministic and only PROPOSES candidates; an LLM decides
// whether a cluster is really one store and writes the merged recipe. Because
// that model reads contributor-controlled text, `verifyMerge` re-checks its
// output field by field against the sources: every value must come from a
// source, so a merge can only ever combine existing content, never invent it.
import type { MerchantRecipe } from "./types";

// Hosts whose LEFTMOST label names the store, not the platform. Without this,
// every Gumroad store would cluster under the label "gumroad".
const PLATFORM_SUFFIXES = [
  "gumroad.com",
  "myshopify.com",
  "bigcartel.com",
  "lemonsqueezy.com",
  "itch.io",
  "company.site",
  "square.site",
  "mybigcommerce.com",
  "squarespace.com",
  "wixsite.com",
  "sellfy.com",
  "ecwid.com",
];

// Two-label public suffixes common enough to matter; without them "foo.co.uk"
// would reduce to the label "co".
const MULTI_TLDS = ["co.uk", "com.au", "co.nz", "com.br", "co.jp", "co.za", "com.mx"];

// The store's identity within its host, normalized so punctuation variants
// collapse ("ruffles-and-rainboots" and "rufflesandrainboots" are one store).
export function storeLabel(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");

  const suffix = PLATFORM_SUFFIXES.find((s) => h.endsWith(`.${s}`));
  // On a platform host the store is the leftmost label; on a custom domain it
  // is the label directly left of the public suffix.
  const label = suffix
    ? h.slice(0, -(suffix.length + 1)).split(".")[0]
    : (() => {
        const parts = h.split(".");
        const tldLabels = MULTI_TLDS.includes(parts.slice(-2).join(".")) ? 2 : 1;
        return parts[parts.length - tldLabels - 1] ?? parts[0];
      })();

  return (label ?? "").replace(/[^a-z0-9]/g, "");
}

// Escaped, not a literal NUL: an embedded NUL byte makes git treat this file as
// binary and hides the whole source from diffs and review.
const pairKey = (a: string, b: string) => [a, b].sort().join("\u0000");

// Group merchant recipes that plausibly describe one store. Only groups of 2+
// are returned — a cluster is a QUESTION for the review model, not a verdict.
//
// Distinct stores do collide on a label ("foo.com" and "foo.net" are unrelated),
// so confirmed-distinct pairs (recipes/distinct.json) suppress a cluster once
// every pair in it is known distinct. Without that, one false positive would be
// re-reported forever.
export function clusterByStore(
  recipes: MerchantRecipe[],
  distinctPairs: string[][] = []
): MerchantRecipe[][] {
  const known = new Set<string>();
  for (const group of distinctPairs) {
    for (const a of group) for (const b of group) if (a !== b) known.add(pairKey(a, b));
  }

  // Connected components, not per-label groups. A recipe whose hosts span two
  // labels belongs to both, and emitting [A,B] and [A,C] separately would let
  // --write merge A into B and then overwrite that result merging A into C,
  // losing B's data. One component per store means each recipe is written once.
  const parent = recipes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[ra] = rb;
  };

  const firstAtLabel = new Map<string, number>();
  recipes.forEach((r, i) => {
    for (const label of new Set(r.hosts.map(storeLabel).filter(Boolean))) {
      const seen = firstAtLabel.get(label);
      if (seen === undefined) firstAtLabel.set(label, i);
      else union(seen, i);
    }
  });

  const components = new Map<number, MerchantRecipe[]>();
  recipes.forEach((r, i) => {
    const root = find(i);
    components.set(root, [...(components.get(root) ?? []), r]);
  });

  return [...components.values()].filter((g) => {
    if (g.length < 2) return false;
    // Suppress only when every pair is confirmed distinct; a newcomer joining a
    // known-distinct pair still gets asked about.
    return !g.every((a) => g.every((b) => a === b || known.has(pairKey(a.id, b.id))));
  });
}

// Contributor prose, keyed by the field it lives in. Checking per-field matters:
// text moved from `evidence` into `notes` is still a lost structured field, even
// though the words survive somewhere.
function textByField(r: Partial<MerchantRecipe>): Map<string, string> {
  const entries: [string, string | undefined][] = [
    ["notes", r.notes],
    ["evidence", r.evidence],
    ["deadEnd.details", r.deadEnd?.details],
    ...(r.gotchas ?? []).map((g) => ["gotchas", g] as [string, string | undefined]),
  ];
  const out = new Map<string, string>();
  for (const [field, value] of entries) {
    if (typeof value !== "string") continue;
    // Kept raw: newlines are the line separator the comparison relies on.
    out.set(field, [out.get(field), value].filter(Boolean).join("\n"));
  }
  return out;
}

const squash = (s: string) => s.replace(/[^\S\n]+/g, " ").trim();
const normalizeLines = (s: string) =>
  s.split("\n").map(squash).filter(Boolean).join("\n");

// Every line of merged prose must appear verbatim in the same field of a source.
// Merging may concatenate and reorder source text; it may not author new text.
function ungroundedLines(value: string, haystack: string): string[] {
  return value
    .split("\n")
    .map(squash)
    .filter((line) => line.length > 0 && !haystack.includes(line));
}

const SCALARS = [
  "platform",
  "status",
  "cardSurface",
  "cvvTarget",
  "exampleProductUrl",
  "lastVerifiedAt",
] as const;

const KNOWN_KEYS = new Set([
  "$schema",
  "id",
  "kind",
  "hosts",
  "overrides",
  "deadEnd",
  "notes",
  "evidence",
  "gotchas",
  ...SCALARS,
]);

// Re-derive the merge from the sources and reject anything that does not follow
// from them. Returns a list of problems; empty means the merge is trustworthy.
export function verifyMerge(merged: unknown, sources: MerchantRecipe[]): string[] {
  const errs: string[] = [];
  if (!merged || typeof merged !== "object") return ["merged recipe is not an object"];
  const m = merged as Record<string, unknown> & Partial<MerchantRecipe>;

  for (const key of Object.keys(m)) {
    if (!KNOWN_KEYS.has(key)) errs.push(`unknown key "${key}" in merged recipe`);
  }
  if (m.kind !== "merchant") errs.push(`kind must be "merchant"`);

  // The id has to be one the registry already used, so a merge cannot mint a
  // new host claim under cover of combining two old ones.
  if (!sources.some((s) => s.id === m.id)) {
    errs.push(`id "${String(m.id)}" is not one of the source ids`);
  }

  const union = [...new Set(sources.flatMap((s) => s.hosts))].sort();
  const got = [...new Set(Array.isArray(m.hosts) ? (m.hosts as string[]) : [])].sort();
  if (JSON.stringify(got) !== JSON.stringify(union)) {
    errs.push(`hosts must be exactly the union of the sources (${union.join(", ")})`);
  }
  if (m.id && !got.includes(m.id)) errs.push(`id "${m.id}" must be one of hosts`);

  for (const key of SCALARS) {
    const v = m[key];
    // Nothing may be invented...
    if (v !== undefined && !sources.some((s) => s[key] === v)) {
      errs.push(`${key} "${String(v)}" appears in no source recipe`);
    }
    // ...and nothing may be lost. The source files are deleted after a merge,
    // so a field the merge omits is gone from the registry for good.
    if (v === undefined && sources.some((s) => s[key] !== undefined)) {
      errs.push(`${key} is set in a source but missing from the merge`);
    }
  }

  // How the checkout actually works is single-valued: if two recipes disagree,
  // one of them is stale and combining them would silently pick a winner.
  for (const key of ["platform", "cardSurface", "cvvTarget"] as const) {
    const values = new Set(sources.map((s) => s[key]).filter((v) => v !== undefined));
    if (values.size > 1) {
      errs.push(`sources disagree on ${key} (${[...values].join(", ")}); merge needs a human`);
    }
  }

  // A dead-end recipe and a working one are a factual contradiction, not a
  // duplicate — one of them is stale and a human has to say which.
  const deadEnds = new Set(sources.map((s) => s.status === "dead-end"));
  if (deadEnds.size > 1) errs.push("sources disagree on dead-end status; merge needs a human");

  for (const [k, v] of Object.entries(m.overrides ?? {})) {
    if (!sources.some((s) => s.overrides?.[k] === v)) {
      errs.push(`overrides.${k} "${v}" appears in no source recipe`);
    }
  }
  for (const k of new Set(sources.flatMap((s) => Object.keys(s.overrides ?? {})))) {
    const values = new Set(sources.map((s) => s.overrides?.[k]).filter((v) => v !== undefined));
    if (values.size > 1) errs.push(`sources disagree on overrides.${k}; merge needs a human`);
    if (m.overrides?.[k] === undefined) {
      errs.push(`overrides.${k} is set in a source but missing from the merge`);
    }
  }

  if (m.deadEnd && !sources.some((s) => s.deadEnd?.type === m.deadEnd?.type)) {
    errs.push(`deadEnd.type "${m.deadEnd.type}" appears in no source recipe`);
  }
  if (!m.deadEnd && sources.some((s) => s.deadEnd)) {
    errs.push("deadEnd is set in a source but missing from the merge");
  }
  // A recipe carries exactly one failure class, so two dead-ends blocked for
  // different reasons cannot be combined without deleting one classification.
  const deadEndTypes = new Set(sources.map((s) => s.deadEnd?.type).filter(Boolean));
  if (deadEndTypes.size > 1) {
    errs.push(
      `sources disagree on deadEnd.type (${[...deadEndTypes].join(", ")}); merge needs a human`
    );
  }

  // Prose is checked FIELD BY FIELD, in both directions. Comparing against all
  // free text at once would let the model move a source's `evidence` into
  // `notes` and count it as both grounded and preserved, while the structured
  // field consumers read is quietly gone.
  const mergedText = textByField(m);
  const sourceText = new Map<string, string>();
  for (const s of sources) {
    for (const [field, value] of textByField(s)) {
      sourceText.set(field, [sourceText.get(field), value].filter(Boolean).join("\n"));
    }
  }

  for (const [field, value] of mergedText) {
    for (const line of ungroundedLines(value, normalizeLines(sourceText.get(field) ?? ""))) {
      errs.push(`${field}: "${line.slice(0, 80)}" appears in no source recipe's ${field}`);
    }
  }
  for (const [field, value] of sourceText) {
    for (const line of ungroundedLines(value, normalizeLines(mergedText.get(field) ?? ""))) {
      errs.push(`source ${field} dropped by the merge: "${line.slice(0, 80)}"`);
    }
  }
  return errs;
}
