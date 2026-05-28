# MiNotes AI Assistant PRD

## Overview

An AI-powered assistant layer that transforms MiNotes from a passive note store into an active knowledge partner. The AI reviews notes, auto-organizes them, surfaces connections, and helps users think better — all while respecting local-first privacy. Every AI feature is opt-in, configurable, and works with either local models (ONNX) or cloud APIs (Anthropic, OpenAI).

## Problem Statement

MiNotes is a well-architected knowledge management app with strong primitives: bidirectional linking, properties, tags, journaling, graph visualization, and git sync. But it is **passive** — the user must manually tag, link, organize, and discover. This is the fundamental friction of every KM app:

1. **Tagging is tedious** — Users write notes, forget to add tags, never revisit organized content
2. **Links are forgotten** — Users don't remember to create `[[wikilinks]]` to related pages
3. **Knowledge is siloed** — Connections between notes exist but are invisible without manual exploration
4. **TODOs get lost** — Tasks created in notes are never revisited or surfaced
5. **Daily notes are empty** — Journaling feels like staring at a blank page
6. **Search is literal** — "Find that note about the project timeline" fails if the words "project" and "timeline" don't appear together

Users don't want another app that stores their notes. They want an app that **helps them think**.

## Design Principles

1. **Local-first, privacy-first** — All AI runs locally by default. Cloud is opt-in. No data leaves the machine unless the user explicitly enables it.
2. **Assist, don't replace** — AI suggests, user approves. Every auto-generated tag, link, or property is marked as AI-suggested and requires confirmation.
3. **Incremental value** — Each AI feature works independently. Users can enable just "auto-tagging" without enabling "semantic search."
4. **Transparent** — Users always know when AI is involved. Suggestions are labeled "AI suggested."
5. **Configurable** — Users choose their model (local vs cloud), set API keys, and control what AI touches.

## Architecture

### Two-Tier AI Model

| Tier | What | How | Cost |
|------|------|-----|------|
| **Tier 1: Local** | Embeddings, auto-tagging, link suggestions, TODO extraction | ONNX Runtime (Rust), local models | $0 |
| **Tier 2: Cloud** | Summarization, writing assistance, knowledge graph analysis, weekly digests | Anthropic/OpenAI via API | Per-token |

### Infrastructure Changes

**Database migration** — Add tables:
- `embeddings` — `(block_id, vector, model_name, version, created_at)`
- `ai_suggestions` — `(id, page_id, suggestion_type, payload JSON, status, created_at)` — stores pending AI suggestions for user review
- `ai_config` — `(key, value)` — user preferences for AI features

**New Rust modules** in `minotes-core`:
- `embedding.rs` — ONNX Runtime inference for text embeddings (all-MiniLM-L6-v2, ~80MB)
- `ai_suggest.rs` — Orchestrates local + cloud AI suggestions
- `ai_config.rs` — Configuration management for AI features
- `hnsw_index.rs` — HNSW vector index for semantic search (using `hnsw-rs` crate)

**New Tauri commands** in `minotes-app`:
- `generate_embedding(content)` — Generate vector embedding for a block
- `search_semantic(query, limit)` — Semantic search using HNSW index
- `get_ai_suggestions(page_id)` — List AI suggestions for a page
- `approve_suggestion(suggestion_id)` — User approves an AI suggestion
- `reject_suggestion(suggestion_id)` — User rejects (trains future suggestions)
- `run_ai_analysis()` — Trigger full knowledge base analysis
- `get_ai_config()` / `set_ai_config()` — AI settings

**Frontend components**:
- `AISuggestionPanel.tsx` — Review AI suggestions (tags, links, properties)
- `SemanticSearchBar.tsx` — Search bar with keyword + semantic toggle
- `AIConfigPanel.tsx` — Settings for AI features (model selection, API keys)
- `KnowledgeDigest.tsx` — Weekly digest view

## Features

### Phase 1: Auto-Organization (Local, No API Key Required)

#### F1: Auto-Tagging
When a page is saved, generate tags from its content using the local embedding model + a lightweight classifier.

**How it works:**
1. On block save, compute embedding for the page's full content
2. Compare against a curated tag taxonomy (stored as embeddings)
3. Suggest tags with confidence scores (e.g., `#rust` 92%, `#systems` 78%)
4. Tags appear in a sidebar panel: "AI suggests: #rust #sqlite #tauri"
5. User clicks to accept/reject each tag

**Taxonomy:** Pre-built with ~200 common tags across domains (tech, science, personal, work, health, finance). Users can add custom tags.

**User Stories:**
- US-1: As a user, I want tags to be auto-suggested when I save a note, so I don't have to think about organization
- US-2: As a user, I want to see confidence scores for suggested tags, so I know how reliable they are
- US-3: As a user, I can add my own tags to the taxonomy, so the AI learns my categorization style

#### F2: Smart Link Suggestions
When editing a page, suggest relevant `[[wikilinks]]` to other pages in the knowledge base.

**How it works:**
1. On save, compute embedding for the current page
2. Compare against all other page embeddings in the HNSW index
3. Show top-3 most similar pages as "Suggested links" in the editor
4. User clicks to insert a wikilink

**User Stories:**
- US-1: As a user, I want the app to suggest related pages I should link to, so my knowledge graph stays connected
- US-2: As a user, I want link suggestions while I'm writing, so I can create connections in the moment

#### F3: TODO Extraction
Scan note content for action items and surface them in a unified TODO view.

**How it works:**
1. On save, run a lightweight NLP model (or cloud LLM for complex cases) to extract TODOs from block content
2. Recognize patterns: `- [ ]`, "TODO:", "Action:", "Follow up:", imperative sentences
3. Surface extracted TODOs in a sidebar panel and a global TODO view
4. TODOs are clickable links back to their source note

**User Stories:**
- US-1: As a user, I want all my TODOs from all notes to appear in one place, so I never lose track of actions
- US-2: As a user, I want the app to recognize TODOs even when I don't use `- [ ]` syntax
- US-3: As a user, I can mark a TODO as done from the global view, and it updates the source note

### Phase 2: Knowledge Intelligence (Local + Cloud)

#### F4: Semantic Search
Search by meaning, not just keywords. "Find that note about the project timeline" matches content even if those exact words aren't used.

**How it works:**
1. All page embeddings are indexed in an HNSW graph
2. User types a natural language query
3. Query is embedded (local model), then nearest-neighbor search finds semantically similar pages
4. Results are ranked by similarity score, shown alongside FTS results
5. Toggle between "Keywords" and "Meaning" search modes

**User Stories:**
- US-1: As a user, I can search by meaning, not just exact words
- US-2: As a user, I want semantic results ranked alongside keyword results, so I get the best of both

#### F5: Connection Discovery
Periodically scan the knowledge base for unlinked but semantically related pages.

**How it works:**
1. Nightly (or on-demand), compare all page embeddings against each other
2. Find pairs with high similarity that don't have wikilinks between them
3. Surface as "Possible connections" in the AI panel: "These 2 pages seem related — link them?"
4. One-click to create a bidirectional link

**User Stories:**
- US-1: As a user, I want the app to find connections I missed between my notes
- US-2: As a user, I get a weekly "discovery report" of new connections found

#### F6: Knowledge Digest
Weekly summary of what was created, connected, and changed.

**How it works:**
1. Aggregate events from the past week: pages created, links added, TODOs completed
2. Generate a natural language summary using a cloud LLM
3. Show in a digest view: "This week you wrote 5 notes, created 12 new links, and completed 3 TODOs. Your most-connected note was 'Q4 Planning'."

**User Stories:**
- US-1: As a user, I get a weekly summary of my note-taking activity
- US-2: As a user, the digest surfaces insights like "You've been writing a lot about Rust this week"

### Phase 3: Writing Assistance (Cloud LLM)

#### F7: AI Writing Assistant
In-editor tools for summarizing, expanding, rewriting, and translating.

**How it works:**
- Slash commands: `/ai-summarize`, `/ai-expand`, `/ai-rewrite`, `/ai-translate`, `/ai-complete`
- Selected text → right-click → "AI" menu
- Summarize a page into bullet points
- Expand a bullet point into a paragraph
- Rewrite for clarity or tone
- Translate to another language
- Complete a sentence (inline autocomplete)

**User Stories:**
- US-1: As a user, I can highlight text and ask AI to summarize/expand/rewrite it
- US-2: As a user, I can use AI to complete sentences while I'm writing

#### F8: Daily Note Assistant
Make journaling effortless with AI-generated prompts and auto-structure.

**How it works:**
1. When opening today's daily note, AI suggests:
   - **Prompts** based on recent notes: "You were working on the sync protocol last week — any updates?"
   - **Structure** from templates: "Today's note includes: morning thoughts, meetings, TODOs, tomorrow's focus"
   - **Recall** from past entries: "On this date last year, you wrote about..."
2. After writing, AI suggests:
   - Tags for the day's entry
   - TODOs extracted from the journal
   - Links to pages mentioned

**User Stories:**
- US-1: As a user, opening my daily note shows AI-generated prompts based on what I've been working on
- US-2: As a user, my daily note auto-suggests structure so it doesn't feel like a blank page
- US-3: As a user, the AI connects my daily entries to my project notes automatically

#### F9: Orphan Detection & Graph Health
Identify pages that are disconnected from the knowledge graph.

**How it works:**
1. Analyze the link graph to find:
   - **Orphan pages** — no incoming or outgoing links
   - **Weakly connected** — only 1 link
   - **Hub pages** — many links but few incoming (potential knowledge anchors)
2. For orphan pages, suggest links using semantic similarity
3. Visual indicator in the sidebar: "3 unlinked notes"
4. One-click "link all orphans" (applies top semantic suggestion for each)

**User Stories:**
- US-1: As a user, I can see which notes are disconnected from my knowledge graph
- US-2: As a user, the app suggests links to reconnect orphaned notes

## Non-Goals

- Real-time AI collaboration (not a team product)
- AI-generated content without user initiation (no auto-writing)
- Voice input / transcription (out of scope)
- Image recognition / OCR (future)
- Replacing the existing FTS5 search (semantic search is complementary)

## Phased Rollout

| Phase | Features | Tech | Timeline |
|-------|----------|------|----------|
| **Phase 1** | Auto-tagging, Link suggestions, TODO extraction | ONNX local models | 4-6 weeks |
| **Phase 2** | Semantic search, Connection discovery, Knowledge digest | HNSW index + cloud LLM | 4-6 weeks |
| **Phase 3** | Writing assistant, Daily note assistant, Orphan detection | Cloud LLM | 4-6 weeks |

## Success Metrics

- **Adoption**: % of users who enable at least one AI feature
- **Engagement**: % of AI suggestions that are accepted (target: >60%)
- **Retention**: Daily note open rate (target: +20% with AI prompts)
- **Graph health**: Average links per page (target: +30% with auto-linking)
- **Search quality**: Semantic search click-through rate vs. keyword search

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Local models are slow on old hardware | Fallback to cloud; cache embeddings; progressive indexing |
| Cloud API costs spiral | Per-feature opt-in; usage caps; local-first defaults |
| AI suggestions are wrong/annoying | Always user-approved; reject feedback loop; confidence scores |
| Privacy concerns | Local-by-default; no data leaves machine without explicit consent |
| Embedding drift as KB grows | Incremental indexing; periodic re-indexing; model versioning |