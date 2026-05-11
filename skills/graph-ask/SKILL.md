---
name: graph-ask
description: Ask any natural language question about the memory graph. You generate Cypher directly and execute it. Use when the user has a complex or ad-hoc question that the standard graph tools don't cover.
argument-hint: [natural language question]
---

The user wants to ask a natural language question about the memory graph.
You will generate the Cypher query yourself and execute it via the graph_cypher MCP tool.

Arguments: $ARGUMENTS

## GRAPH SCHEMA

All entity nodes carry both :Entity and their type label (e.g., :Entity:Person).
All entities have: id (STRING), name (STRING), subtype (STRING), confidence (FLOAT),
times_mentioned (INTEGER), first_seen (DATETIME), last_seen (DATETIME), source_file (STRING).

Node labels (8 types):
- Person: role, relationship_to_user, organization, email
- Project: status, stack, description, directory, start_date
- Preference: domain, key, value, times_confirmed
- Concept: category, user_expertise, description
- Decision: what, why, context, reversible (BOOLEAN), status, decided_date
- Fact: domain, content, source, verified (BOOLEAN)
- Event: description, event_date (DATETIME), duration, outcome, location, status
- Object: object_type, description, status, url, version

Relationship types (17 total, all have weight FLOAT and last_confirmed DATETIME):
- WORKS_ON (Person->Project): role, since
- PREFERS (Person->Preference): strength
- KNOWS_ABOUT (Person->Concept): depth
- DEPENDS_ON (Project->Project): dependency_type
- USES_TECH (Project->Concept): role
- DECIDED_FOR (Decision->any)
- SUPERSEDES (Decision->Decision): reason, superseded_date
- CONTRADICTS (any->any): description, detected_date, resolved (BOOLEAN), resolution
- RELATED_TO (any->any): relationship_type (similar_to, part_of, enables, impacts, depends_on, alternative_to, derived_from, implements, extends, configured_by)
- ALIAS_OF (any->any)
- PARTICIPATED_IN (Person->Event): role
- OCCURRED_DURING (Event->Project)
- PRODUCED (Event->Decision|Object|Fact)
- TRIGGERED_BY (Event->Event)
- USES (Project|Person->Object): purpose
- HOSTED_ON (Object->Object)
- PRODUCED_BY (Object->Project|Event)

---

## QUERY TEMPLATES

Use these tested templates for common question patterns. Fill in the `$param` values and adjust as needed.

### T1 — Find everything connected to an entity
```cypher
MATCH (n:Entity)-[r]-(m:Entity)
WHERE toLower(n.name) CONTAINS toLower($name)
  AND r.weight > 0.3
RETURN n.name AS entity, type(r) AS relation, m.name AS connected, m.type AS connected_type, r.weight AS weight
ORDER BY r.weight DESC LIMIT 50
```
*Use for: "what do you know about X?", "tell me about Y"*

### T2 — List entities of a type
```cypher
MATCH (n:Entity:$Type)
WHERE n.confidence > 0.3
RETURN n.name AS name, n.confidence AS confidence, n.subtype AS subtype
ORDER BY n.confidence DESC, n.times_mentioned DESC LIMIT 50
```
*Replace `$Type` with Person, Project, Concept, Decision, Fact, Event, Object, or Preference.*
*Use for: "list all projects", "what people do I know?", "show my decisions"*

### T3 — Path between two entities
```cypher
MATCH path = shortestPath((a:Entity)-[*..4]-(b:Entity))
WHERE toLower(a.name) CONTAINS toLower($nameA)
  AND toLower(b.name) CONTAINS toLower($nameB)
RETURN [n IN nodes(path) | n.name] AS path_nodes,
       [r IN relationships(path) | type(r)] AS relations
LIMIT 5
```
*Use for: "how is X related to Y?", "connect X and Y"*

### T4 — Recent entities (added in last N days)
```cypher
MATCH (n:Entity)
WHERE n.first_seen > datetime() - duration({days: $days})
RETURN n.name AS name, n.type AS type, n.confidence AS confidence, n.first_seen AS added
ORDER BY n.first_seen DESC LIMIT 50
```
*Use for: "what did you learn recently?", "new entities this week"*

### T5 — Strong preferences and decisions
```cypher
MATCH (p:Entity:Person)-[r:PREFERS]->(pref:Entity:Preference)
WHERE r.weight > 0.5
RETURN p.name AS person, pref.name AS preference, pref.properties.value AS value, r.weight AS strength
ORDER BY r.weight DESC LIMIT 30

UNION

MATCH (d:Entity:Decision)
WHERE d.confidence > 0.5
RETURN "Decision" AS person, d.name AS preference, d.properties.what AS value, d.confidence AS strength
ORDER BY d.confidence DESC LIMIT 20
```
*Use for: "what are my preferences?", "what decisions have been made?"*

### T6 — Technologies used by a project
```cypher
MATCH (proj:Entity:Project)-[r:USES_TECH]->(tech:Entity)
WHERE toLower(proj.name) CONTAINS toLower($projectName)
  AND r.weight > 0.2
RETURN proj.name AS project, tech.name AS technology, tech.type AS tech_type, r.weight AS weight
ORDER BY r.weight DESC LIMIT 30
```
*Use for: "what tech does X use?", "stack for project Y"*

### T7 — Contradictions
```cypher
MATCH (a:Entity)-[r:CONTRADICTS]->(b:Entity)
WHERE r.resolved = false
RETURN a.name AS entity_a, b.name AS entity_b, r.properties.description AS conflict, r.properties.detected_date AS detected
ORDER BY r.properties.detected_date DESC LIMIT 20
```
*Use for: "what contradictions exist?", "conflicting facts"*

### T8 — Entities by source session
```cypher
MATCH (n:Entity)-[r]-()
WHERE r.source_session = $sessionId
RETURN DISTINCT n.name AS name, n.type AS type, n.confidence AS confidence
ORDER BY n.confidence DESC LIMIT 50
```
*Use for: "what was extracted from session X?", "show last dream output"*

### T9 — Weakest / stale entities (candidates for pruning)
```cypher
MATCH (n:Entity)
WHERE n.confidence < 0.25
  AND n.last_seen < datetime() - duration({days: 60})
RETURN n.name AS name, n.type AS type, n.confidence AS confidence, n.last_seen AS last_seen
ORDER BY n.confidence ASC LIMIT 30
```
*Use for: "what might be pruned?", "stale graph entries"*

### T10 — Full-text search across names and properties
```cypher
MATCH (n:Entity)
WHERE toLower(n.name) CONTAINS toLower($term)
   OR toLower(toString(n.properties)) CONTAINS toLower($term)
RETURN n.name AS name, n.type AS type, n.confidence AS confidence
ORDER BY n.confidence DESC LIMIT 50
```
*Use for: broad keyword searches when you're not sure of the entity name*

---

## Steps

1. Match the user's question to the closest template above (or compose from scratch if none fit)
2. Fill in parameters; adjust filters if the user asks for weak/all connections
3. Call `graph_cypher` with the query
4. Present results:
   - Show the Cypher in a code block
   - Show results as a readable table or list
   - If empty: suggest a broader term or related template
5. If the query fails: read the error, fix the Cypher, and retry once

## Rules
- Only read-only Cypher (MATCH / RETURN / WITH / WHERE / ORDER BY / LIMIT / SKIP / UNWIND)
- Default LIMIT 50 unless user asks for more
- Default weight > 0.3 filter unless user asks for weak or all connections
- Always show the Cypher you generated

If no question is provided, ask the user what they'd like to know.
