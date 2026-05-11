---
name: ingest
description: Ingest a file or URL into the memory graph. Handles local files (text, PDF, DOCX, XLSX, images, etc.) and URLs (web pages, YouTube, Wikipedia, RSS). Use when the user wants to add any document or web content to their knowledge graph.
argument-hint: <file-path-or-url> [--now] [--source "type"] [--author "name"] [--topic "hint1, hint2"]
---

The user wants to ingest a document or URL into the graph memory system.

Arguments: $ARGUMENTS

## Step 1: Parse arguments

- First positional argument: file path or URL (required)
- `--now`: process immediately inline (Claude extracts entities in this session)
- `--source`: document type label, e.g. "article", "meeting notes", "YouTube transcript"
- `--author`: creator/author name
- `--topic`: topic hints for better extraction (comma-separated string)

If no argument is provided, ask the user for a file path or URL.

## Step 2: Detect input type

**URL** (starts with `http://` or `https://`):
- YouTube URLs (`youtube.com` or `youtu.be`) → MarkItDown fetches transcript + metadata
- All other URLs (web pages, Wikipedia, RSS, Bing) → MarkItDown converts to markdown
- Go to Step 3A

**Local file**:
- Native text formats (`.md`, `.txt`, `.srt`, `.vtt`, `.json`, `.html`, `.csv`) → queue directly, skip MarkItDown
- Binary/rich formats (`.pdf`, `.docx`, `.doc`, `.xlsx`, `.xls`, `.pptx`, `.ppt`, `.epub`, `.ipynb`, `.msg`, `.eml`, `.zip`, images) → convert via MarkItDown first
- Go to Step 3B

## Step 3A: URL ingestion via MarkItDown

1. Run MarkItDown on the URL:
   ```
   markitdown "<url>" -o "~/graph-memory/.tmp/graph-ingest-tmp.md"
   ```
2. If it fails, report the error and stop
3. Read the output file to check it has content (not empty)
4. Derive a filename from the URL: slugify the domain + path, e.g. `youtube-com-watch-dQw4w9WgXcQ.md`
5. Continue to Step 4 using the temp `.md` file as the file to queue

## Step 3B: Local file ingestion

**Native text file:** use the file path as-is, go to Step 4.

**Binary/rich file:**
1. Run MarkItDown on the local file:
   ```
   markitdown "<file-path>" -o "~/graph-memory/.tmp/graph-ingest-tmp.md"
   ```
2. If it fails, report the error with the MarkItDown output and stop
3. Read the output to verify it has meaningful content
4. Derive a filename: take the original basename and replace the extension with `.md`
   - e.g. `report.pdf` → `report.md`
5. Continue to Step 4 using the temp `.md` file

## Step 4: Queue or process immediately

Build the meta object from flags:
```json
{
  "source": "<from --source flag, or inferred: 'web', 'youtube', 'pdf', etc.>",
  "author": "<from --author flag if provided>",
  "date": "<today's date YYYY-MM-DD>",
  "topic_hints": ["<split --topic on commas if provided>"]
}
```
Only include fields that have values.

**If `--now` is NOT set (default -- queue for later):**
1. Copy the file directly to `~/graph-memory/ingest/pending/<filename>` using Bash
2. Write the meta object to `~/graph-memory/ingest/pending/<filename>.meta.json`
   (Only include fields that have values -- omit empty keys)
3. Report:
   - What was queued (filename, source type)
   - For URLs: the page title if MarkItDown extracted one
   - "Will be processed on the next dream run (`/graph-dream`)"

Note: Do NOT use the `graph_ingest` MCP tool for queuing -- it runs inside the Docker container and only sees its own mounted volumes. Write directly to the pending dir on the host instead.

**If `--now` IS set (immediate inline processing):**
1. Read the file content
2. Extract entities and relationships (you reason about the content):
   - People, projects, technologies, preferences, decisions, facts, events
   - Focus on knowledge, not formatting or navigation elements
3. For each candidate entity: call `graph_entities` with a search to check if it already exists
4. Call `graph_relate` for new entities and relationships (use batch mode for efficiency)
5. Call `graph_boost` for reinforcements of existing knowledge
6. Report: source, entities created, edges created, any notable findings

## Notes

- MarkItDown handles: PDF, DOCX, XLSX, PPTX, EPUB, MSG/EML, IPYNB, CSV, ZIP, images, HTML, YouTube, Wikipedia, RSS
- For non-YouTube video platforms (Vimeo, TikTok, Loom, etc.) use `/yt-dlp <url>` instead
- For local audio files (MP3, WAV, M4A) use `/ingest-audio <file>` instead
- MarkItDown should be on PATH after `pip install "markitdown[pdf,docx,xlsx,pptx]"`. If it isn't, ask the user to confirm the install location.
