# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Production (Docker)

```bash
./install.sh          # First-time setup: build images, pull Ollama models, start all services
./restart.sh          # Stop and restart all services
./stop.sh             # Stop all services
./update.sh           # Check for remote update and apply, or rebuild from local files
./export.sh           # Create a versioned .tar.gz archive for deployment
docker compose logs -f backend   # Stream backend logs
```

### Password management

```bash
cd backend && npm run password:reset-teacher   # Generate a referent password (forces change at next login)
```

Account passwords are stored with bcrypt hashes. Create and manage named accounts from the
administration interface.

### Frontend development

```bash
cd frontend && npm run dev      # Vite dev server (hot reload)
cd frontend && npm run build    # Production build to frontend/dist (+ .br/.gz precompressed assets served by the backend)
```

### Backend development

```bash
cd backend && npm run dev       # Node --watch (auto-restart on file change)
cd backend && npm test          # Unit/integration tests (node:test, no Ollama/ChromaDB needed)
cd backend && npm run import:site   # Import pages from a sitemap URL
```

## Architecture

The project is a local RAG-based AI assistant, generic and configurable for any organization (branding, thematic scope, and update server are set per instance — see `docs/CONFIGURATION.md`). This particular deployment is configured for IUTLab Mulhouse via `backend/data/branding.json` (not versioned; `backend/config/branding.default.json` holds the generic defaults). It runs fully in Docker with these services: **backend** (Express/Node), **frontend** (React/Vite, served as static files by the backend in production), **Ollama** (local LLM), **ChromaDB** (vector store), **Redis** (job queue), **updater** (sidecar for remote updates). Only the backend's port is published on the host; Ollama/ChromaDB/Redis are reachable only on the internal Docker network.

### Request flow

1. User submits a question at `GET /` (public, no auth)
2. Frontend sends to `POST /api/chat` → `backend/routes/chat.js`
3. Request enters a **Bull queue** (`queueService.js`) backed by Redis — enforces one active chat at a time
4. `ragService.js` embeds the question via Ollama (`embeddinggemma-2:740m`), searches ChromaDB per-folder collections, ranks chunks, and builds a context string
5. Context + conversation history + enabled `manual_resources` (instructions/links from DB) + `improvement_rules` (feedback-derived rules) are assembled into a prompt
6. Prompt is streamed to Ollama (`ollamaService.js`), and tokens are forwarded to the client via **Socket.IO** (`realtimeService.js`)

### Authentication

Named accounts use bcrypt hashes. The referent password can be auto-generated at install time;
the next referent login then requires a password change before using the administration area.

JWT is issued on login (cookie `token`, httpOnly), validated by `authMiddleware.js` on all `/api/admin/*` routes.

### Data model (SQLite via `better-sqlite3`)

Initialized in `config/db.js`. Key tables:
- `documents` — file metadata + indexing state (`pending`/`indexed`/`error`)
- `manual_resources` — admin-defined instructions, links injected into prompts (document links carry scrape state: `scrape_status`, `scraped_at`, `scrape_error`, `scraped_chars`)
- `settings` — key/value store (active model, embedding model, etc.)
- `conversations` / `messages` / `conversation_exchanges` — chat history
- `feedback` / `improvement_rules` — admin corrections that feed back into future prompts
- `answer_ratings` — user 👍/👎 ratings on answers; similar rated Q/A pairs are injected into prompts as examples/anti-examples (`ratingService.js`)
- `user_attachments` — text files uploaded by chat users; indexed into ChromaDB, admin-triaged (keep/delete), auto-deleted after 30 days if untriaged (`attachmentService.js`)
- `chat_metrics` — performance data per query
- `skills` — predefined answer methods (SKILL.md format) injected into the prompt: activation `auto` (trigger match), `always`, or `manual` (picked by the user in the chat). Templates live in `backend/config/skills/*.md` (`skillService.js`)
- `analytics_dismissed_questions` — unanswered questions already handled by a referent (resource created or dismissed)

### Extra ChromaDB collections

Besides per-folder collections (`assistant_<folder>`), retrieval also queries:
- `assistant_web_links` — scraped content of admin document links (`webScrapeService.js`); cited as clickable sources
- `assistant_attachments` — user attachment content; used for answers but never shown as a downloadable source

### Document indexing pipeline

`fileService.js` syncs the `backend/uploads/` filesystem to the `documents` DB table. `queueService.js` processes indexing jobs: each document is parsed (PDF via `pdf-parse`, DOCX via `mammoth`, XLSX via `xlsx`, HTML via `cheerio`, etc.), split into chunks with `TokenTextSplitter`, embedded, and stored in a per-folder ChromaDB collection named `folder_<name>`.

For PDFs, `pdfVisionService.js` finds pages with meaningful images (`pdfimages -list`, ignoring masks, tiny images and logos repeated across pages) or almost no text (scans, vector drawings), renders them (`pdftoppm`, pdf-parse fallback) and has the vision model (role "image", else the chat model if it declares the `vision` capability) describe them. Descriptions become extra chunks (`content_type: "visual"`, `page_number`) with a page header, and are cached in `document_visual_descriptions` (file md5 + model + page + prompt version) so reindexing does not rerun vision. Pure helpers live in `pdfVisionPages.js`.

### Context window and conversation memory

`ollamaService.getModelProfile()` reads `/api/show` and derives a stable `num_ctx` per model (`contextBudget.computeEffectiveContextWindow`). Prompt messages carry a `kind` (`rag`, `attachment`, `examples`, `history`, `question`, none = never trimmed); `ragService.fitChatMessagesForModel()` fits them to the answering model's window: instructions and question intact, last exchange guaranteed, documents shared fairly, recent history verbatim, older exchanges condensed into a memory message. The chat gauge receives these figures via the SSE `context` event.

### Backups

`backupService.js` writes `.tar.gz` archives (SQLite online backup + `uploads/` + `branding.json`) to `data/backups/` (`BACKUP_DIR`), daily at the time set in the admin (scheduler), with rotation. Restore validates the archive (no links, no path traversal, SQLite integrity), takes a safety backup, swaps the database (`closeDatabase()` + `initializeDatabase()`), then rebuilds the ChromaDB indexes in the background. Administrator-only.

### Frontend routing

React SPA with `react-router-dom`. Routes: `/` (UserChat), `/admin` (ModelAdminPage — protected by `AppGate`), `/release` (ReleaseNotesPage). The `/admin` page opens on a dashboard and contains all management tabs: documents, manual resources, skills, chat home (announcement banner + suggested questions), analytics (CSV exports), model config, conversations, updates, and — administrators only — backups, data purge, accounts, audit, deployment.

The public chat keeps conversations in the browser only (`frontend/src/lib/conversationStore.js`, 30 days, can be disabled by the user), loads `GET /api/chat/home` (announcement, suggestions, user-selectable skills) and sends the chosen `skillId` with each question.

## Key environment variables

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs session JWTs |
| `CONFIG_ENCRYPTION_KEY` | AES-256-GCM key encrypting sensitive DB settings (e.g. deployment FTP credentials) — see `backend/utils/secretsCrypto.js` |
| `ADMIN_ACCESS_MODE` | `any` (default) or `local` (restrict admin to local network) |
| `DEFAULT_MODEL` | Ollama model used for chat (role "text") |
| `EMBEDDING_MODEL` | Ollama model used for embeddings |
| `MODEL_CATALOG_SOURCE_URL` | Optional remote JSON URL for weekly model catalog refresh; empty = static catalog only |
| `CHAT_HISTORY_LIMIT` | Max messages kept verbatim in the prompt; older ones are condensed (`contextBudget.js`) |
| `OLLAMA_NUM_CTX` / `OLLAMA_AUTO_CTX_MAX` / `OLLAMA_MEMORY_BUDGET_GB` | Per-model context window: explicit cap, or automatic from model max + KV-cache memory |
| `PDF_VISION_*` | Vision indexing of illustrated/scanned PDF pages (`pdfVisionService.js`) |
| `PROJECT_WORKSPACE_DIR` | Absolute path to repo root, used for Docker volume mounts |

Copy `.env.example` to `.env` before first run; `install.sh` does this automatically. See
`docs/CONFIGURATION.md` for the full picture (branding, multi-model roles, secrets).
