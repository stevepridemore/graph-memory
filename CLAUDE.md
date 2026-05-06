# Graph Memory

You have access to a graph-based memory system via the `graph-memory` MCP server.

## When to consult the graph

- When the user asks about a **person**, **project**, **past decision**, or **preference** — call `graph_query` before answering from general knowledge
- When the user references something from a **previous conversation** — the graph likely has context
- When you're about to **write a memory file** — check `graph_entities` first to see if related knowledge already exists
- When the user starts a new session — consider offering `/graph-briefing` if the project has graph data

## How to use it

- `graph_query` for structured lookups (entities, relationships, weights)
- `graph_cypher` when you need a custom query (you know the schema — see /graph-ask skill)
- `graph_boost` when the user confirms something you recalled from the graph
- `graph_weaken` when the user corrects something the graph got wrong

## Writing to the graph during conversation

You MAY write to the graph during conversation for **high-confidence, explicit** knowledge — but follow these rules:

### When to write (call `graph_relate`)
- User explicitly states a fact, preference, or decision ("I prefer X", "we decided Y", "Z works for me")
- User introduces a person, project, or tool by name with clear context
- User confirms or corrects something you recalled from the graph

### When NOT to write (defer to the dream process)
- Inferred context or things you're guessing from the conversation
- Casual mentions without clear significance
- Anything you're not confident about — the dream process will catch it later

### Weight guidelines
| Origin | Weight |
|--------|--------|
| Explicit user statement ("I prefer X", "we use Y") | 0.7 |
| User confirmed recalled info ("yes, exactly") | boost +0.15 |
| Mentioned in context but not stated directly | **don't write** — let dream handle at 0.3 |

### Use specific relationship types — not just RELATED_TO
| Relationship | When to use |
|-------------|-------------|
| WORKS_ON | Person → Project |
| USES / USES_TECH | Person/Project → Technology |
| KNOWS_ABOUT | Person → Concept/Technology |
| PREFERS | Person → Preference |
| DECIDED_FOR | Person/Project → Decision |
| PARTICIPATED_IN | Person → Event |
| RELATED_TO | Only when nothing else fits |

### Always include provenance
- `source_type`: `"conversation"`
- `source_session`: the current session ID if available

### Never write
- API keys, passwords, tokens, or secret values (note existence only)
- Meta-events about the current session (bug fixes, tool tests, etc.)

## What NOT to do

- Don't query the graph for every message — only when the topic involves recallable knowledge
- Don't mention weights or graph internals to the user unless they ask
