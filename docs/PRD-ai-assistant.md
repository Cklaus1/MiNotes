# PRD: AI in MiNotes

Status: ~15% built (rule-based stand-ins only) · Owner: Chris Klaus · Revised 2026-10-10

> **What changed in this revision.** The original (May 2026) planned a local
> ONNX embedding model + HNSW index for tags/links/search, with a cloud LLM only for
> writing help. Since then frontier models became far more capable and much cheaper
> (e.g. Claude Haiku 5.5 at $0.10 / $0.50 per million tokens in/out; 1M-token
> context across the current Claude line), and good local models run on a laptop.
> That changes the design: one **AI platform** that every feature uses, built around
> a capable model with tools over the notebook ("agentic retrieval") instead of a
> bespoke ML stack, and **preview-and-undo for every change**. Cloud models are
> reached through **OpenRouter** (decided 2026-10-10), so users pick any model with
> one key. The rule-based
> features that exist today stay as the offline / AI-off fallback.

## 1. Status of what exists

| Feature | Status | Where |
|---|---|---|
| Tag suggestions | Partial — regex `#tag` extraction, shown as chips | `lib/tagExtractor.ts`, `PageView.tsx` |
| Link suggestions | Partial — title/keyword overlap (made stricter Oct 2026) | `lib/linkSuggestions.ts` |
| TODO extraction | Done (rule-based) — count, "All TODOs" page, sidebar badge | `todoExtractor.ts`, `repo/ai_suggestions.rs` |
| AI toggles in Settings | Done — autoTag / linkSuggestions / todoExtraction | `lib/settings.ts`, `SettingsPanel.tsx` |
| Orphan count | Partial — computed, not shown | `repo/graph.rs` |
| Any model, embeddings, semantic search, chat, writing help, digests | Not started | — |

## 2. Problem

Notes pile up faster than people organise or revisit them. Keyword search fails
when you don't remember the words; links and tags don't get added; tasks buried in
meeting notes are forgotten; a blank daily page goes unused. And increasingly
people want their AI assistant (Claude, a coding agent) to use their notes — today
that means copy-paste.

## 3. Principles

1. **Off until the user turns it on; private by default.** No note content leaves
   the device unless the user picked a cloud provider for that notebook. A local
   model is a first-class option, not a downgrade path.
2. **Nothing changes without consent.** The AI proposes; the user sees a preview
   (diff for edits, list for bulk changes) and applies. Every applied change is one
   undo step and is attributed to "AI" in the event log.
3. **Answers cite sources.** Anything the AI says about your notes links to the
   blocks it came from; no citation, no claim.
4. **Scoped access.** AI reads only what the user allowed (whole notebook, chosen
   Projects, or the current page). Encrypted notebooks: AI off unless explicitly
   enabled for that notebook, and then local models are recommended.
5. **Cost is visible and capped.** Per-run token/cost shown; monthly cap; no
   background spend the user didn't schedule.
6. **Rules where rules are better.** Exact things (dates, counts, TODO syntax,
   merges) stay deterministic; AI is for judgment and language.

## 4. The AI platform (shared by every feature and spec)

### 4.1 Providers

| Provider | How | Notes |
|---|---|---|
| **OpenRouter** — the cloud provider | User's own OpenRouter API key, stored in the OS keychain | One key for many models. The model list comes from OpenRouter's catalogue (filtered to models that support tools), chosen per task class; the newest Claude Opus is preselected as the recommended default, and the user decides the cost/quality trade. Notes go to OpenRouter and to the model's provider — the settings notice names both. |
| **Local** | Any OpenAI-compatible local server (Ollama, LM Studio, llama.cpp) | Nothing leaves the device; quality depends on the model; features that need tool use check capability and degrade (e.g. no agent actions) rather than fail. |
| Direct provider APIs (e.g. Anthropic) | Later, if users need provider-specific features or want to skip the intermediary — same provider interface, or a plugin (`PRD-plugin-architecture.md` "AI provider" extension point) | |

- Calls are made from the **Rust backend**, never the webview (keys stay out of the
  page; the CSP stays closed). OpenRouter and local servers share one
  OpenAI-compatible client; requests stream; long notebook context uses prompt
  caching where the model supports it.
- Every call goes through one `ai::run(task, scope, input)` function that enforces
  scope, budget, logging and the provider choice. Features never call a provider
  directly.

### 4.2 Tools over the notebook (agentic retrieval)

Instead of an embedding index as the only route to "find relevant notes", the model
gets read-only tools backed by core: `search(query)` (FTS5), `get_page(id|title)`,
`get_blocks(ids)`, `backlinks(page)`, `list_pages(filter)`, `get_properties`,
`todos(filter)`, `recent(days)`. It searches iteratively, the way a person would.
For small notebooks the whole scope fits in context and is cached.

**Optional semantic index** (Phase 2): a small local embedding model (runs on CPU,
no network) indexing blocks incrementally, exposed as one more tool
`semantic_search(query)`. Built only if evals show agentic search misses too much.

**Write tools** never write: `propose_edit`, `propose_new_page`, `propose_move`,
`propose_property`, `propose_link` return a **proposal** the user reviews. Applying
a proposal calls the normal core APIs (transactions, undo, link sync).

### 4.3 Data

- `ai_runs`: task, scope, provider/model, input/output token counts, cost estimate,
  started/finished, outcome — the user can see what was sent and when (content
  itself is not logged unless the user enables "keep transcripts").
- `ai_proposals`: pending proposals with their diff/payload, status, run id.
- Settings per notebook: provider, models per task class, scope, monthly cap,
  feature toggles. Keys only in the keychain.

## 5. Features

Ranked by user value.

| # | Feature | What the user gets | Phase |
|---|---|---|---|
| 1 | **Ask your notes** | A chat panel: questions answered from your notes with block citations ("What did we decide about pricing?"). Follow-ups keep context; "open source" jumps to the block. | 1 |
| 2 | **Natural-language search** in the Ctrl+K palette | "the meeting about pricing last week" finds it even without those words; results are ranked pages/blocks, not a chat. Falls back to FTS instantly while the AI result streams in. | 1 |
| 3 | **AI in the editor** | Select text or a block → rewrite / shorten / expand / fix grammar / translate / explain / continue; `/ai <instruction>` in an empty block drafts content (uses page and linked pages as context). Always shown as a diff to accept. | 1 |
| 4 | **Organise (review queue)** | Proposed tags, links (`[[…]]` where a page is mentioned), Project for unfiled pages, duplicate pages to merge, orphans to connect — reviewed as a batch with accept/reject per item. Replaces the regex/overlap heuristics when AI is on. | 2 |
| 5 | **Tasks from notes** | Finds action items written as prose ("Sam to send the deck by Friday"), proposes TODO blocks with owner and due date. Counting and the TODO syntax stay rule-based. | 2 |
| 6 | **Daily brief / weekly review** | Opt-in, scheduled locally: open tasks, what changed, things you wrote about but didn't follow up, notes worth resurfacing — written into the journal as a normal page section (editable, deletable). | 2 |
| 7 | **Agent actions** | "Turn my reading notes from this month into a summary page", "file every page about Acme under the Acme project and link them" — the model plans, produces a set of proposals, the user reviews the whole change set, applies it as **one** undo step. Scoped and budgeted. | 3 |
| 8 | **Cleanup on paste / import** | Pasted email, web page or meeting transcript → clean outline blocks; Evernote/HTML imports tidied (`PRD-import.md`). Preview before insert. | 2 |

**AI hooks in other specs** use this platform rather than their own integration:
kanban (board from a messy page), mindmap (map from a document), sidebar
(natural-language jump, file unfiled pages), editor (plain-English queries,
instruction-driven templates), git sync (explain a conflict, propose a merged
block), import (cleanup). Each spec's "Where AI helps" section owns the UX; this
spec owns the plumbing, consent and cost rules.

### Non-goals

- Silent background edits or auto-applied changes.
- Training on user notes; sending notes anywhere except the provider the user chose.
- Multi-user collaboration features.
- Voice, OCR and image understanding (later — the current models accept images, so
  OCR of pasted images is a cheap Phase 3 candidate).

## 6. UX

- **Settings → AI**: provider (OpenRouter key / local endpoint / off), model per task
  class (interactive, bulk, agent), scope, monthly cap and spend so far, per-feature
  toggles, "keep transcripts", data notice in plain words ("Your notes in *Work*
  are sent to OpenRouter and Anthropic when you use AI features" — naming the selected model's provider).
- **First use**: an explicit setup screen — nothing is enabled implicitly.
- **AI panel** (right side): Ask, the review queue (proposals with diffs, bulk
  accept/reject), recent runs with cost.
- Proposals and AI-written text are visually marked until accepted; accepted AI
  edits are normal content (no permanent badge), with "AI" attribution in history.
- Offline / no provider: AI entry points show a short explanation and the rule-based
  features keep working.

## 7. Phases

1. **Platform + Ask + palette search + editor AI**: provider layer (OpenRouter + local),
   keychain, `ai::run`, read tools, proposals + review UI, cost meter and cap,
   settings, mock provider for tests.
2. **Organise, tasks, daily brief, paste cleanup**; semantic index only
   if evals require it.
3. **Agent actions**, OCR of pasted images, more providers via plugins.

## 8. Quality and testing

- **Eval sets** before shipping each feature: golden notebooks (fixtures) with
  questions and expected cited blocks (Ask), queries with expected pages (search),
  pages with expected tags/links/tasks (Organise), edit instructions with rubric
  grading (editor). Track accuracy, citation precision, refusal/"don't know" rate,
  cost and latency per model. Re-run on every prompt or model change.
- **Deterministic tests** with a recorded/mocked provider: scope enforcement (a
  question about a Project outside scope must not see its blocks), proposals never
  writing without apply, undo of a multi-edit apply, budget cap stops a run, keys
  never reach the webview, AI off in encrypted notebooks by default.
- Desktop journeys (desktop-check skill) for the panel, review queue and editor flow
  against the mock provider; one opt-in live run against a real key.

## 9. Success metrics

- ≥ 25% of active users enable AI within 3 months of release; ≥ 50% of those use it
  weekly.
- Ask: ≥ 85% of eval answers correct with valid citations; users open a cited source
  in ≥ 30% of sessions.
- Organise: ≥ 60% proposal acceptance; links per page +30% for AI users.
- Zero incidents of content sent outside the configured scope/provider.
- Median interactive latency (first token) < 2 s on the default cloud model.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Wrong answers presented confidently | Citations required; "not found in your notes" is an accepted answer; evals gate releases. |
| Privacy expectations violated | Off by default, per-notebook provider choice, scope, plain-language notice, run log, local option, encrypted notebooks excluded by default. |
| Cost surprises | Per-run cost, monthly cap, no unscheduled background runs, user-chosen models per task class. |
| Prompt injection from note content (a pasted web page telling the model to do something) | Notes are data: tools are read-only, writes are proposals the user approves, no network tools for the model in v1. |
| Local models too weak for tool use | Capability check per feature; degrade to Ask-only or retrieval + single answer. |
| Provider/model changes | One provider layer; model per task class configurable; evals rerun on change. |

## 11. Open questions

1. Default model per task class for new users — the newest Claude Opus everywhere,
   or suggest a cheaper model for bulk work at setup?
2. Should MiNotes offer a hosted key (paid AI plan) later, or stay bring-your-own-key?
3. An MCP server so outside agents (Claude, coding agents) can use your notes —
   wanted at all? Not planned.
4. Keep transcripts by default (useful for "why did it say that?") or off (privacy)?
5. Should the rule-based tag/link heuristics stay visible when AI is on, or be
   replaced entirely?
