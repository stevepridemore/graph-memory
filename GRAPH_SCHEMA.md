# Graph Schema (vocabulary)

Concise reference for the node types and edge verbs used in the memory
graph. Optimized for the agent (Claude) to scan when writing edges, and
for humans skimming the project.

For the full reference (weight math, decay functions, validity windows,
init Cypher, example queries) see
[`docs/GRAPH_SCHEMA_REFERENCE.md`](docs/GRAPH_SCHEMA_REFERENCE.md).

## Conventions

- Every node carries the `:Entity` label plus its specific type label.
- Edges are directed in storage; symmetric edges are stored once and
  queried without an arrow (see "Directionality" below).
- Prefer a specific verb over `RELATED_TO`. `RELATED_TO` is the
  fallback for "connected somehow but nothing else fits."
- All nodes share these common properties: `id`, `name`, `subtype`,
  `confidence` (0.0–1.0), `times_mentioned`, `first_seen`, `last_seen`,
  `tenant_id`, optionally `embedding` (384-dim).

## Status legend

- ✅ **In use** — appears in the current graph and is documented here.
- 🆕 **Proposed** — added during the 2026-05-10 vocabulary expansion.
  Dream + in-conversation writes should start using these; a future
  retyping campaign will backfill existing `RELATED_TO` edges.
- 🤔 **Consolidation candidate** — overlaps with another type and may
  be merged in a future cleanup. Use the canonical sibling unless the
  distinction is meaningful for your case.

## Node types

| Type | Use when | Notes |
|---|---|---|
| `Person` ✅ | A human (user, colleague, family, contact) | Subtypes: `individual`, `contact`, `group` |
| `Organization` ✅ | A company, agency, team, or institution | E.g. FBBE, Anthropic |
| `Project` ✅ | A bounded body of work, initiative, or codebase | Subtypes: `active`, `paused`, `completed`, `abandoned` |
| `Feature` ✅ 🤔 | A sub-component of a Project | Overlaps with `Project`; use only when the feature has its own lifecycle worth tracking separately. Otherwise prefer Project + describe the feature in properties. |
| `Concept` ✅ | An abstract idea, pattern, framework, or technology category | The fallback for "named thing that isn't an instance" |
| `Technology` ✅ 🤔 | A specific tool, language, library, or platform | Overlaps with `Concept`. Currently a categorized Concept; the live graph uses both. Convention going forward: prefer `Technology` for concrete tech (React, Neo4j); `Concept` for abstractions (LLM-wiki-pattern, MVC). |
| `Decision` ✅ | A choice made or position taken | Often emitted by the dream extractor from "we decided…" / "I chose…" statements. |
| `Reasoning` ✅ | The why behind a Decision | Pairs with Decision via `LED_TO`; lighter than Decision itself. |
| `Preference` ✅ | A stated user preference or rule | Person `PREFERS` Preference. Has `domain`, `key`, `value` properties. |
| `Event` ✅ | A point-in-time happening | Meeting, milestone, release, incident |
| `Fact` ✅ | A standalone piece of knowledge | Description-heavy. Best paired with `ABOUT` to whatever it's a fact *about*. |
| `Artifact` ✅ | A created/authored output (doc, file, transcript, gist) | Subtype of Object — distinct because authorship matters. Pair with `AUTHORED` / `PRODUCED`. |
| `Object` ✅ 🤔 | A "thing in the world" that isn't covered by a more specific type | Heavy overlap with `Resource` and `Infrastructure`. The live graph leans on this as a catch-all; consider whether your case is really `Resource`, `Infrastructure`, or `Artifact` first. |
| `Resource` ✅ 🤔 | A consumable or referenceable thing | Overlaps with `Object`. Currently rare in graph (1 node). Candidate for merge into `Object` unless it earns its keep. |
| `Infrastructure` ✅ 🤔 | A server, host, network device, deployment target | Overlaps with `Object`. Currently rare (1 node). Candidate for merge into `Object` with `subtype: infrastructure`. |
| `Alias` ✅ | An alternate name pointing at a canonical entity | Used by alias resolution; rarely created directly. |

**Consolidation summary:** `Object` / `Resource` / `Infrastructure`
overlap heavily — the latter two have only 1–2 nodes each. A future
cleanup can collapse them into `Object` with subtypes. `Concept` /
`Technology` is a softer overlap; the rule above (concrete = Technology,
abstract = Concept) keeps both useful.

## Edge verbs

Verbs are grouped by purpose. Direction notation: `A → B` means the
edge points from A to B.

### People & roles

| Verb | Direction | Use when |
|---|---|---|
| `WORKS_ON` ✅ | Person → Project | Person actively contributes to a project |
| `WORKS_AT` ✅ | Person → Organization | Employment |
| `REPORTS_TO` ✅ | Person → Person | Org-chart reporting line |
| `STAKEHOLDER_IN` ✅ | Person → Project/Decision | Has interest but isn't owner |
| `KNOWS` 🆕 | Person ↔ Person | General acquaintance (symmetric) |
| `COLLABORATES_WITH` 🆕 | Person ↔ Person | Active working relationship (symmetric) |
| `FAMILY_OF` 🆕 | Person ↔ Person | Family tie; use a `role` property (`spouse`, `sibling`, `parent`) |
| `MENTOR_OF` 🆕 | Person → Person | Mentorship/teaching |

### Knowledge, preferences, decisions

| Verb | Direction | Use when |
|---|---|---|
| `KNOWS_ABOUT` ✅ | Person → Concept/Technology | Subject-matter familiarity |
| `PREFERS` ✅ | Person → Preference | Stated preference |
| `DECIDED_FOR` ✅ | Person/Project → Decision | Owns or made a decision |
| `LED_TO` ✅ | Event/Decision → Outcome | Causal arrow |
| `INVOLVED_IN` ✅ | Person → Event/Project | Lighter than `PARTICIPATED_IN` |

### Tech & dependencies

| Verb | Direction | Use when |
|---|---|---|
| `USES` ✅ | * → Tool/Object | General usage |
| `USES_TECH` ✅ | Project → Technology | Specifically a technology dependency |
| `DEPENDS_ON` ✅ | * → * | Functional dependency |
| `IMPLEMENTS` 🆕 | Project/Class → Concept/Interface | Concrete realization of a pattern; in code, "class implements interface" |
| `EXTENDS` 🆕 | Class → Class | Code-level class inheritance (Java `extends`) |
| `INSPIRED_BY` 🆕 | Project → Concept/Project | Origin/influence without inheritance |
| `BUILDS_ON` 🆕 | * → * | Direct extension at the idea level |
| `DERIVED_FROM` 🆕 | * → * | Descended from another (forks, extracted concepts) |

### Composition & taxonomy

| Verb | Direction | Use when |
|---|---|---|
| `CONTAINS` 🆕 | * → * | Composition (repo contains file; project contains feature) |
| `PART_OF` 🆕 | * → * | Inverse of `CONTAINS`; pick one direction per fact, don't store both |
| `INSTANCE_OF` 🆕 | Object → Concept | Concrete thing of an abstract category |
| `CATEGORIZED_AS` 🆕 | * → Concept | Lighter classification when `INSTANCE_OF` is too strong |

### Reference & description (covers the biggest current `RELATED_TO` bucket)

| Verb | Direction | Use when |
|---|---|---|
| `ABOUT` 🆕 | Fact/Artifact → * | The fact or document is *about* its subject |
| `DESCRIBES` 🆕 | Artifact → * | Artifact describes its subject (stronger authoring intent than `ABOUT`) |
| `DOCUMENTS` 🆕 | Artifact → Project/Object | Specifically reference documentation |
| `ATTRIBUTED_TO` 🆕 | Fact/Quote → Person | Source of a statement or observation |

### Authorship, production, governance

| Verb | Direction | Use when |
|---|---|---|
| `PRODUCED` ✅ | Person/Project → Artifact/Event | Authorship of an output |
| `AUTHORED` 🆕 | Person → Artifact | Wrote/created a doc, post, or code |
| `CREATED` 🆕 | Person → Project/Object | Brought something into existence (broader than `AUTHORED`) |
| `AFFECTS` 🆕 | Decision → Object/Project | A decision applies to or constrains a target |
| `GOVERNS` 🆕 | Decision/Policy → * | Stronger than `AFFECTS` — the target is *bound by* the decision |

### Lifecycle & ordering

| Verb | Direction | Use when |
|---|---|---|
| `SUPERSEDES` ✅ | * → * | Bi-temporal replacement (with `valid_at`) |
| `REPLACES` 🆕 | Object → Object | Successor; less formal than `SUPERSEDES` (no bi-temporal contract) |
| `DEPRECATED_BY` 🆕 | Object → Object | Inverse of `REPLACES`; the source is on its way out |
| `BLOCKS` 🆕 | Issue/Task → Issue/Task | Forward dependency |
| `BLOCKED_BY` 🆕 | Issue/Task → Issue/Task | Inverse of `BLOCKS` |
| `RESOLVED_BY` 🆕 | Issue/Fact → Decision/Event | Closes a contradiction or open question |

### Place & runtime

| Verb | Direction | Use when |
|---|---|---|
| `LOCATED_IN` 🆕 | Person/Object → Place | Geographic placement |
| `DEPLOYED_TO` 🆕 | Project → Infrastructure/Place | Runtime deployment target |

### Events & temporal

| Verb | Direction | Use when |
|---|---|---|
| `PARTICIPATED_IN` ✅ | Person → Event/Organization | Membership / past involvement |
| `OCCURRED_DURING` ✅ | Event → Event/Time | Temporal containment |
| `TRIGGERED_BY` ✅ | Event/Decision → Event/Cause | What caused this |

### Identity & contradiction

| Verb | Direction | Use when |
|---|---|---|
| `ALIAS_OF` ✅ | * ↔ * | Same thing, different name (kept un-merged); symmetric |
| `CONTRADICTS` ✅ | * ↔ * | Mutually exclusive facts surfaced for human review |
| `RELATED_TO` ✅ | * → * | **Fallback only** — use a specific verb if one fits |

## Directionality

Neo4j stores every relationship with a direction, but you can query
without one. Three patterns:

1. **Symmetric verbs** (`KNOWS`, `COLLABORATES_WITH`, `FAMILY_OF`,
   `ALIAS_OF`, `CONTRADICTS`, `RELATED_TO`): store one edge, query
   without an arrow (`MATCH (a)-[r:KNOWS]-(b)`). Direction in storage
   is meaningless.
2. **Inverse-pair verbs** (`CONTAINS`/`PART_OF`, `BLOCKS`/`BLOCKED_BY`,
   `REPLACES`/`DEPRECATED_BY`): only store one direction per fact —
   pick the canonical (typically active voice → forward arrow) and let
   queries follow either.
3. **Asymmetric verbs** (`AUTHORED`, `EXTENDS`, `INSPIRED_BY`,
   `WORKS_ON`, etc.): direction is meaningful and unique. Only one edge.

Never store both directions of the same fact — it doubles storage and
the weights drift out of sync over time.

## When to write to the graph during conversation

See the rules in [`CLAUDE.md`](CLAUDE.md). Short version:

- Write only for **high-confidence, explicit** statements (weight 0.7).
- Always include provenance: `source_type: "conversation"` and the
  current `source_session` if available.
- Never write secrets (API keys, passwords, tokens). Note existence
  only.
- Defer ambiguous or inferred context to the dream process at weight
  0.3.

## Adding a new verb or node type

1. Decide whether it's rare enough to warrant `RELATED_TO` (or
   `Object`), or whether it deserves a name.
2. If it deserves a name, add it here with status 🆕, direction, and a
   one-sentence "use when."
3. Update `~/.claude/GRAPH_SCHEMA.md` if the new type is genuinely
   universal (applies in any project), not just this one.
4. After it sees real use across multiple sessions, change status to ✅.

