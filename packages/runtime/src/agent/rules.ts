// The tier 1 rules the judge holds a diff to, as the agent is told them:
// generated from the same sources the judge reads (the rule list, the
// profile, and banned.json at the base), so the two can't drift and the agent
// meets them on the first pass instead of learning them from a failed round.
import { buildContext } from "@arynbht/rivetari-engine";

import { loadBanned } from "../judge/banned.js";
import { DIFF_RULES, MARKDOWN_ALWAYS_SKIPPED } from "../judge/diff-rules.js";
import type { Card } from "../task/card.js";

export async function tier1Rules(
  repoPath: string,
  base: string,
  card: Card,
): Promise<string[]> {
  const profile = await buildContext(repoPath)
    .profile()
    .catch(() => null);
  const on: Record<(typeof DIFF_RULES)[number]["id"], boolean> = {
    "diff.no-new-comments": profile?.quality?.["no-new-comments"] ?? false,
    "diff.markdown-in-card": true,
    "diff.no-new-suppressions": true,
  };
  const generated = profile?.generated ?? [];
  const skipped = [
    MARKDOWN_ALWAYS_SKIPPED.map((g) => g.replace(/\*\*$/, "")).join(", "),
    ...(generated.length > 0
      ? [`the profile's generated paths ${generated.join(", ")}`]
      : []),
  ].join(" and ");
  const extra: Partial<Record<(typeof DIFF_RULES)[number]["id"], string>> = {
    "diff.markdown-in-card": ` (the card names: ${card.touches.join(", ") || "nothing"}; Markdown under ${skipped} is skipped)`,
  };
  const rules = DIFF_RULES.filter((r) => on[r.id]).map(
    (r) => `${r.id}: ${r.title}${extra[r.id] ?? ""}.`,
  );
  const banned = await loadBanned(repoPath, base).catch(() => null);
  for (const p of banned?.patterns ?? [])
    rules.push(
      `${p.id}: nothing matching /${p.pattern}/ in ${p.files}${p.allow.length > 0 ? ` (allowed in ${p.allow.join(", ")})` : ""}; ${p.why}.`,
    );
  return rules;
}
