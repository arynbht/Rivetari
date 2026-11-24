// Schema and contract files: what other code, services or apps read as the
// shape of the data. A change to one is a schema change whatever the file is
// called, so the profile can name its own (a domain types file a mobile app
// mirrors) on top of the common formats here. How the change is asked follows
// from what it does: one that removes, renames or retypes anything, or adds
// something a reader must now supply, is always asked; one that only adds
// optional fields or new types can be flagged for the PR instead, as a soft
// stop, because nothing that read the old shape breaks on the new one.
import type { Hunk } from "../judge/diff-rules.js";
import type { DiffEntry } from "../judge/protected.js";

/** Schema and contract files in any repo, before the profile adds its own. */
export const CONTRACT_DEFAULTS = [
  // Database schema and migrations.
  "**/migrations/**",
  "**/migrate/**",
  "**/*.sql",
  "**/*.prisma",
  // API contracts.
  "**/openapi*.{yaml,yml,json}",
  "**/swagger*.{yaml,yml,json}",
  "**/*.proto",
  "**/*.graphql",
  "**/*.gql",
  "**/*.avsc",
  "**/*.thrift",
  // JSON Schema.
  "**/*.schema.json",
] as const;

export interface ContractChange {
  path: string;
  /** Why it can't be flagged, one line each; empty when it only adds. */
  breaking: string[];
}

const COMMENT = /^(?:\/\/|\/\*|\*|#|--)/;
// A line of brackets and separators carries no field of its own; it moves
// whenever a block around it is edited.
const PUNCTUATION = /^[\s{}()[\];,]*$/;

const meaningful = (line: string) => {
  const t = line.trim();
  return t !== "" && !COMMENT.test(t) && !PUNCTUATION.test(t);
};
const normal = (line: string) =>
  line
    .trim()
    .replace(/[,;]\s*$/, "")
    .replace(/\s+/g, " ");

// Formats whose lines say whether an addition is optional. Anything else
// (OpenAPI and JSON Schema list required fields apart from the fields, and a
// profile's own files can be anything) is asked whatever it adds.
const KINDS: [RegExp, Kind][] = [
  [/\.(?:d\.)?[cm]?[jt]sx?$/i, "ts"],
  [/\.(?:graphql|gql)$/i, "graphql"],
  [/\.proto$/i, "proto"],
  [/\.prisma$/i, "prisma"],
  [/\.sql$/i, "sql"],
];
type Kind = "ts" | "graphql" | "proto" | "prisma" | "sql";

const kindOf = (path: string): Kind | undefined =>
  KINDS.find(([re]) => re.test(path))?.[1];

/** A line that opens a declaration of its own: everything in it is new too. */
const DECLARATION: Record<Kind, RegExp> = {
  ts: /^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|class|namespace)\s/,
  graphql: /^(?:extend\s+)?(?:type|input|interface|enum|union|scalar|schema)\s/,
  proto: /^(?:message|enum|service)\s/,
  prisma: /^(?:model|enum|type|view)\s/,
  sql: /^CREATE\s/i,
};

const OPTIONAL: Record<Kind, (line: string) => boolean> = {
  // `name?: T`, an import, or a new export that stands on one line.
  ts: (t) =>
    /^(?:readonly\s+)?["']?[\w$-]+["']?\?\s*:/.test(t) ||
    /^import\s/.test(t) ||
    /^export\s+(?:type|const|interface|enum)\s/.test(t),
  // A field without `!` may be null, so no reader has to send it.
  graphql: (t) => /^\w+\s*(?:\(.*\))?\s*:/.test(t) && !t.includes("!"),
  // proto3 fields are all optional; proto2's `required` is the exception.
  proto: (t) =>
    /^(?:optional\s+|repeated\s+)?(?:map<[^>]+>|[\w.]+)\s+\w+\s*=\s*\d+/.test(
      t,
    ) && !/^required\s/.test(t),
  prisma: (t) => /^\w+\s+\w+(?:\[\])?\?/.test(t) || t.includes("@default("),
  sql: (t) => {
    if (
      /\b(?:DROP|RENAME|TRUNCATE|DELETE|UPDATE|ALTER\s+COLUMN|MODIFY|CHANGE\s+COLUMN)\b/i.test(
        t,
      )
    )
      return false;
    if (/\bADD\s/i.test(t)) return !/NOT\s+NULL/i.test(t) || /DEFAULT/i.test(t);
    return /^(?:ALTER\s+TABLE\s+\S+$|BEGIN|COMMIT|INSERT\s)/i.test(t);
  },
};

const depth = (line: string) =>
  (line.match(/[{([]/g)?.length ?? 0) - (line.match(/[})\]]/g)?.length ?? 0);

const quoted = (line: string) => {
  const t = line.trim().replace(/\s+/g, " ");
  return `\`${t.length > 80 ? `${t.slice(0, 79)}…` : t}\``;
};

/**
 * What a change to one contract file does: `breaking` says why it has to be
 * asked (removed or changed lines, or additions a reader must now supply),
 * and is empty when the change only adds optional fields or new types.
 */
export function contractChange(
  entry: DiffEntry,
  hunks: readonly Hunk[],
): ContractChange {
  const { path } = entry;
  if (entry.status === "D") return { path, breaking: ["deletes the file"] };
  if (entry.status === "R")
    return { path, breaking: [`renames it from ${entry.oldPath ?? "?"}`] };
  const addedSet = new Set(
    hunks.flatMap((h) => h.added.filter(meaningful).map(normal)),
  );
  const removedSet = new Set(
    hunks.flatMap((h) => h.removed.filter(meaningful).map(normal)),
  );
  const breaking: string[] = [];
  // A line removed in one place and added back in another only moved.
  for (const line of hunks.flatMap((h) => h.removed.filter(meaningful)))
    if (!addedSet.has(normal(line)))
      breaking.push(`removes or changes ${quoted(line)}`);
  const kind = kindOf(path);
  if (!kind) {
    const first = hunks
      .flatMap((h) => h.added)
      .find((l) => meaningful(l) && !removedSet.has(normal(l)));
    if (first !== undefined)
      breaking.push(
        `adds ${quoted(first)} to a file whose additions can't be told optional`,
      );
    return { path, breaking };
  }
  for (const hunk of hunks) {
    let inside = 0;
    for (const line of hunk.added) {
      const t = line.trim();
      if (inside > 0) {
        inside += depth(t);
        continue;
      }
      if (!meaningful(line) || removedSet.has(normal(line))) continue;
      if (DECLARATION[kind].test(t)) {
        inside = Math.max(0, depth(t));
        continue;
      }
      if (!OPTIONAL[kind](t))
        breaking.push(`adds ${quoted(line)}, which isn't optional`);
    }
  }
  return { path, breaking };
}
