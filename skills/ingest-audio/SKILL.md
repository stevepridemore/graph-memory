---
name: ingest-audio
description: Transcribe a local audio or video file using Whisper and ingest it into the memory graph. Use when the user has a local MP3, WAV, M4A, MP4, or similar audio/video file they want to add to their knowledge graph.
argument-hint: <file-path> [--model base] [--topic "hint1, hint2"] [--author "name"] [--now]
---

The user wants to transcribe a local audio or video file and ingest it into the graph memory system.

Arguments: $ARGUMENTS

## Step 1: Parse arguments

- First positional argument: local file path (required)
- `--model`: Whisper model size. Default: `base`. Options: `tiny`, `base`, `small`, `medium`, `large`
  - `tiny`: fastest, least accurate (~39MB)
  - `base`: good balance, recommended default (~74MB)
  - `small`: noticeably better accuracy (~244MB)
  - `medium`: high accuracy, slow on CPU (~769MB)
  - `large`: best accuracy, very slow on CPU (~1.5GB)
- `--topic`: topic hints for metadata (comma-separated)
- `--author`: speaker or creator name
- `--now`: process immediately inline after transcription instead of queuing

If no file path is provided, ask the user for one.

## Step 2: Verify Whisper is installed

Run: `whisper --help`

If this fails, report:
```
Whisper is not installed. Install it with:
  pip install openai-whisper

Note: This downloads model weights (~74MB for 'base') on first run.
ffmpeg is also required:
  - Windows: winget install ffmpeg
  - macOS:   brew install ffmpeg
  - Linux:   apt install ffmpeg (or your distro's equivalent)
```
Then stop.

## Step 3: Verify the file exists and is a supported format

Supported: `.mp3`, `.wav`, `.m4a`, `.mp4`, `.ogg`, `.flac`, `.webm`, `.mkv`, `.avi`, `.mov`

If the file doesn't exist or the format isn't supported, report the issue and stop.

## Step 4: Transcribe with Whisper

Output directory: `~/graph-memory/.tmp/graph-audio-ingest/`

Run:
```
whisper "<file-path>" --model <model> --output_format txt --output_dir "~/graph-memory/.tmp/graph-audio-ingest/"
```

Whisper outputs `<original-filename>.txt` in the output directory.

Note: This may take several minutes for longer files on CPU. Inform the user that transcription is running.

If transcription fails, report the error and stop.

## Step 5: Read and validate the transcript

Read the output `.txt` file. If it's empty or very short (under 20 words), warn the user:
- "Transcript appears empty or very short. The audio may be silent, too quiet, or in a different language."
- Suggest trying `--model small` or `--model medium` for better accuracy.

## Step 6: Prepare the output markdown file

Write a markdown file to `~/graph-memory/.tmp/graph-audio-ingest/<original-basename>.md`:

```markdown
# <original filename without extension>

**Source:** audio transcription
**Original file:** <basename>
**Transcribed with:** Whisper <model>
**Date:** <today's date>
<if --author: **Speaker:** <author>>

## Transcript

<full transcript text>
```

Write the `.meta.json` sidecar alongside it:
```json
{
  "source": "audio",
  "author": "<from --author flag if provided>",
  "date": "<today YYYY-MM-DD>",
  "topic_hints": ["<split --topic on commas if provided>"],
  "original_file": "<basename of input file>",
  "whisper_model": "<model used>"
}
```
Only include fields that have values.

## Step 7: Queue or process immediately

**If `--now` is NOT set (default):**
1. Copy the `.md` file to `~/graph-memory/ingest/pending/<filename>.md` using Bash
2. Write the meta object to `~/graph-memory/ingest/pending/<filename>.md.meta.json`
3. Report:
   - Original file and model used
   - Approximate word count of the transcript
   - "Queued -- will be processed on the next dream run (`/graph-dream`)"

Note: Do NOT use the `graph_ingest` MCP tool for queuing -- it runs inside Docker and only sees its own mounted volumes. Write directly to the pending dir on the host.

**If `--now` IS set:**
1. Read the markdown content
2. Extract entities and relationships inline (you reason about the content)
3. For each candidate entity: call `graph_entities` to check if it already exists
4. Call `graph_relate` for new entities and relationships (batch mode preferred)
5. Call `graph_boost` for reinforcements of existing knowledge
6. Report: entities created, edges created, key topics found

## Notes

- Whisper runs entirely locally -- free, no API key needed, no data leaves your machine
- First run for a given model downloads the weights (e.g. ~74MB for `base`)
- For YouTube or online video URLs, use `/ingest <url>` (uses youtube_transcript_api, no local compute needed)
- For non-YouTube video platforms, use `/yt-dlp <url>` which tries subtitles first before falling back to Whisper
- ffmpeg must be installed for Whisper: `winget install ffmpeg` (Windows), `brew install ffmpeg` (macOS), `apt install ffmpeg` (Linux)
