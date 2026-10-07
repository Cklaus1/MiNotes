# PRD: Plugin Architecture

## 1. Overview

This PRD defines a unified plugin architecture for MiNotes that replaces the two dead-end systems currently in place (the native plugin registry with no execution engine, and the frontend-only Obsidian-compatible plugin loader) with a single, practical plugin system. The system is designed to deliver immediate value through extracted built-in features (SRS cards, CSS snippets) while establishing a platform extensible enough for future plugin types.

**One-liner:** A tiered plugin system where built-in features are extracted into native Rust plugins at runtime, and third-party plugins extend the app via shared libraries (Rust) or TypeScript, all orchestrated through a unified lifecycle and manifest-driven permission model.

## 2. Problem Statement

MiNotes currently has two non-functional plugin systems that serve no operational purpose:

1. **Native Plugin Registry** (`plugins` table + CRUD commands): Stores plugin metadata (id, name, description, enabled flag) and associated key-value storage, but nothing is ever loaded, executed, or lifecycle-managed. It is a schema with no runtime. Commands exist (`list_plugins`, `register_plugin`, `enable_plugin`, `disable_plugin`, `uninstall_plugin`, `plugin_storage_get`, `plugin_storage_set`) but serve no purpose since there is no engine to act on them.

2. **Obsidian-Compatible Plugin Loader** (`PluginLoader` class): Evaluates JavaScript in the browser via `new Function()`, provides a complete Obsidian API shim (App, Vault, Workspace, Plugin, Editor, etc.), and allows loading plugins from source code or bundled manifests. This works purely in the frontend with no backend persistence, no sandboxing, no versioning, and no integration with MiNotes' data layer. It also uses a raw eval-style pattern that is a security concern.

Both systems address the same fundamental need -- extensibility -- but neither delivers it. Meanwhile, several features that should be plugins (SRS card management, CSS snippets, graph visualization, PDF annotation, template system) are hardcoded into `minotes-core`. This couples the core to features that should be optional, makes the binary larger than necessary, and prevents users from disabling or replacing them.

## 3. Architecture

### 3.1 Runtime Model: Hybrid Tiered Approach

| Tier | Runtime | Language | Use Case | Sandbox |
|------|---------|----------|----------|---------|
| **Core Plugins** (built-in) | Rust, compiled into `minotes-core` | Rust | SRS, snippets, graph, PDF, templates | N/A (trusted, compiled) |
| **Native Plugins** (third-party) | `.so`/`.dll`/`.dylib` via `libloading` | Rust (or languages that compile to C ABI) | Backend-heavy extensions, CLI commands, search indexers | Process-level isolation via Tauri permissions |
| **Frontend Plugins** (third-party) | Dynamic import in browser | TypeScript/JavaScript | UI extensions, editor hooks, custom views | Tauri iframe-like restrictions, permission manifest |

**Why not WASM?** WASM offers the best sandboxing story, but introduces significant complexity: WASI support, runtime embedding, compilation toolchain dependencies for plugin authors, and performance overhead. For a desktop app where the threat model is "user installs plugins they trust," native shared libraries and typed TypeScript are sufficient. WASM can be added as a Tier-4 later.

**Why not pure native or pure frontend?** Pure native excludes all the rich UI extension use cases. Pure frontend (current Obsidian loader) excludes backend-heavy use cases and provides no data layer access. The hybrid approach gives each tier the right tools for its job.

### 3.2 High-Level Architecture

```
                    PluginHost (Rust)
                    +-------------------+
                    | Core Plugins      |
                    |  (compiled in,    |
                    |   always-on)      |
                    |  - srs_cards      |
                    |  - css_snippets   |
                    |  - graph_view     |
                    |  - pdf_viewer     |
                    |  - templates      |
                    +-------------------+
                    | Native Plugins    |
                    |  (loaded via      |
                    |   libloading)     |
                    |  - CLI commands   |
                    |  - search plugins |
                    |  - sync backends  |
                    +-------------------+
                    | Frontend Bridge   |
                    |  (Tauri commands  |
                    |   for TS plugins) |
                    +-------------------+

                    Frontend Plugin Runtime (TypeScript in browser)
                    +-------------------+
                    | PluginAPI (TS)    |
                    |  - tauri.invoke() |
                    |  - event.subscribe|
                    |  - storage.get/set|
                    +-------------------+
                    | Custom Views      |
                    |  (React components |
                    |   injected into UI)|
                    +-------------------+
```

### 3.3 Key Design Decisions

**Decision 1: Core features extracted as "built-in plugins"**

SRS cards, CSS snippets, graph visualization, PDF viewing, and templates are extracted from `minotes-core`'s monolithic command handlers into plugin modules. They remain compiled into the binary but are structured as plugins with lifecycle hooks. Users can disable them via settings. This means:
- The same `plugins` table already exists -- we repurpose it for enabled/disabled state
- The same `plugin_storage` table already exists -- used for plugin data
- The `events` table already emits events -- we route relevant events to plugin subscribers
- No new schema is needed initially

**Decision 2: Frontend and backend plugins share a unified registry**

The existing `plugins` table becomes the single source of truth. Every plugin (core or third-party) has:
- A manifest (JSON) describing id, name, version, capabilities, permissions
- An enabled/disabled state
- A storage namespace in `plugin_storage`
- An event subscription list

**Decision 3: Permission model based on manifest declarations**

Plugins declare what they need in their manifest. Core plugins are pre-approved (all permissions granted). Third-party plugins only get what they declare, and the user approves at install time.

### 3.4 Plugin Icon Bar (UI)

A persistent icon bar in the sidebar's `.stats-bar` area (bottom of sidebar, below the 5 mode buttons) provides at-a-glance visibility into which plugins are active and quick access to their actions.

**Placement:** Bottom of the sidebar, immediately after the existing `.stats-modes-grid` (Graph, Mindmap, Draw, Kanban, Pages buttons). This is the same visual zone as the mode buttons — users already look here for tools.

**Visual Design:**

```
┌──────────────────────────────────────────────────────────┐
│  📊  🧠  🎨  📋  📄  ───  🃏  🎨  📊  📝  +            │
│  Graph Mind Draw Kanban Pages  SRS Snippets Graph View   │
└──────────────────────────────────────────────────────────┘
```

- **Layout:** Horizontal row of small icon buttons (24x24px), separated from mode buttons by a thin divider line
- **Icons:** Each plugin declares a `manifest.ui.icon` field (emoji or SVG). Core plugins ship with emoji icons. Third-party plugins can provide SVG/PNG icons.
- **Tooltips:** Hover shows plugin name + version (e.g., "Spaced Repetition Cards v1.0.0")
- **Disabled state:** Dimmed/grayed out, with a strikethrough or opacity 0.4
- **Overflow:** If more than ~7 plugins are enabled, a `+` button appears. Clicking it opens a dropdown list of remaining plugins (same pattern as Chrome extensions overflow)
- **Click behavior:**
  - If the plugin has registered actions → opens a small action menu (popup) with available commands
  - If the plugin has no actions → toggles the plugin's enabled/disabled state
  - If the plugin has a registered view → opens the plugin's view in the right sidebar

**Action Menu (popup on click):**

```
┌──────────────────────────────────┐
│  🃏 Spaced Repetition Cards      │
│  ─────────────────────────────── │
│  ▶ Open Review Panel (⌘R)       │
│  📊 View Stats                    │
│  ⚙️ Plugin Settings               │
│  ─────────────────────────────── │
│  Disable Plugin                   │
└──────────────────────────────────┘
```

- **Trigger:** Click on a plugin icon that has registered actions
- **Position:** Appears directly above the icon bar, aligned with the clicked icon
- **Content:** Dynamically generated from the plugin's `manifest.ui.commands` field
- **Keyboard:** Arrow keys navigate, Enter executes, Escape closes
- **Auto-dismiss:** Closes when clicking outside or after 5 seconds of inactivity

**Plugin Registration of Actions:**

Plugins declare their actions in the manifest:

```json
{
  "ui": {
    "icon": "🃏",
    "actions": [
      {
        "id": "open-review",
        "title": "Open Review Panel",
        "shortcut": "⌘R",
        "command": "srs.open-review"
      },
      {
        "id": "view-stats",
        "title": "View Stats",
        "command": "srs.view-stats"
      }
    ]
  }
}
```

The `PluginHost` exposes these actions to the frontend via a Tauri command:

```rust
#[tauri::command]
async fn get_plugin_actions(state: State<'_, AppState>) -> Result<Vec<PluginAction>> {
    // Returns all actions from all enabled plugins
}
```

**Plugin Bar Component:**

```tsx
// crates/minotes-app/src/components/PluginBar.tsx

interface PluginBarProps {
  plugins: PluginInfo[];
  onTogglePlugin: (id: string) => void;
  onExecuteAction: (actionId: string) => void;
  onOpenSettings: (pluginId: string) => void;
}

function PluginBar({ plugins, onTogglePlugin, onExecuteAction, onOpenSettings }: PluginBarProps) {
  // Renders horizontal icon row
  // Shows tooltip on hover
  // Opens action menu popup on click
  // Handles overflow (+) button
  // Shows disabled state for disabled plugins
}
```

**Settings Panel Integration:**

The existing Settings panel gets a new "Plugins" tab (in addition to Appearance and Sync & Backup). This tab shows:

```
┌────────────────────────────────────────────────────┐
│  Plugins                                           │
│  ───────────────────────────────────────────────── │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🃏 Spaced Repetition Cards v1.0.0            │  │
│  │ FSRS-based flashcard system                  │  │
│  │ [ON/OFF toggle]  [Storage: 0 KB]  [Settings]│  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🎨 CSS Snippets v1.0.0                       │  │
│  │ Custom CSS injection for theming             │  │
│  │ [ON/OFF toggle]  [Storage: 12 KB]  [Settings]│  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │ 📊 Graph View v1.0.0                         │  │
│  │ Knowledge graph visualization                │  │
│  │ [ON/OFF toggle]  [Storage: 0 KB]  [Settings] │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
│  ─────────────────────────────────────────────────   │
│  [Install Plugin...]  [Obsidian Compatibility]       │
└────────────────────────────────────────────────────┘
```

**Command Palette Integration:**

Plugin actions appear in the command palette (`>` mode) alongside existing commands:

```
> plugins
  ▶ Open Review Panel (⌘R)
  ▶ View SRS Stats
  ▶ Open CSS Snippets Manager
  ▶ Toggle Graph View
  ▶ Open Plugin Settings
```

**Summary of UI elements:**

| Element | Location | Purpose |
|---------|----------|---------|
| **Plugin Icon Bar** | Bottom of sidebar (`.stats-bar`) | At-a-glance plugin visibility, quick action access |
| **Action Menu Popup** | Above icon bar, triggered by click | Execute plugin commands without navigating |
| **Settings Panel → Plugins tab** | Right sidebar slide-in panel | Full plugin management (enable/disable, storage, settings) |
| **Command Palette entries** | `>` mode in search panel | Keyboard-accessible plugin actions |
| **Overflow dropdown** | `+` button in icon bar | Access to plugins that don't fit in the icon bar |

## 4. Plugin Interface Design

### 4.1 Plugin Manifest Format

Every plugin must ship with a `minotes-plugin.json` manifest:

```json
{
  "id": "srs-cards",
  "name": "Spaced Repetition Cards",
  "version": "1.0.0",
  "core_api_version": "1.0",
  "description": "FSRS-based flashcard system for review of blocks",
  "author": "MiNotes",
  "type": "core",
  "enabled": true,
  "permissions": [
    "pages:read",
    "pages:write",
    "blocks:read",
    "blocks:write",
    "events:subscribe"
  ],
  "ui": {
    "views": [
      { "id": "review", "position": "sidebar-right", "defaultVisible": false }
    ],
    "commands": [
      { "id": "srs.open-review", "title": "Open Review Panel", "shortcut": "Cmd+R" }
    ]
  },
  "backend": {
    "entry_point": "libminotes_plugin_srs.so",
    "hooks": ["on_block_created", "on_card_reviewed"]
  },
  "frontend": {
    "entry_point": "dist/plugin.js",
    "hooks": ["editor_context_menu", "sidebar_panel"]
  }
}
```

### 4.2 Rust Plugin Trait Interface

```rust
// crates/minotes-core/src/plugin/mod.rs

/// Core trait all plugins must implement.
#[async_trait]
pub trait Plugin: Send + Sync {
    /// Stable unique identifier, matches manifest.id
    fn id(&self) -> &str;

    /// Human-readable name.
    fn name(&self) -> &str;

    /// Semantic version string.
    fn version(&self) -> &semver::Version;

    /// Called once at app startup. Plugins can register Tauri commands,
    /// set up state, or perform initialization.
    fn init(&mut self, ctx: PluginContext) -> Result<()>;

    /// Called when the plugin is enabled (if it was previously disabled
    /// or is newly registered).
    fn on_enable(&mut self, ctx: PluginContext) -> Result<()>;

    /// Called when the plugin is disabled. Plugin should clean up
    /// background tasks, deregister commands, etc.
    fn on_disable(&mut self) -> Result<()>;

    /// Called during app shutdown. Plugin should flush any pending state.
    fn on_shutdown(&mut self) -> Result<()>;

    /// Whether this plugin is currently active.
    fn enabled(&self) -> bool;

    /// Permission scope this plugin operates within.
    fn permissions(&self) -> &[Permission];

    /// Register any Tauri commands this plugin wants to expose.
    fn register_commands(&self, commands: &mut Vec<tauri::command::CommandInfo>) {
        // default: no-op
    }
}
```

### 4.3 PluginContext

```rust
pub struct PluginContext {
    /// Direct database access (within plugin's permission scope).
    pub db: DatabaseRef,

    /// Event bus for subscribing to and emitting events.
    pub events: EventEmitter,

    /// Per-plugin persistent key-value storage.
    pub storage: PluginStorage,

    /// Frontend communication (Tauri emit for UI updates).
    pub frontend: FrontendBridge,

    /// CLI command dispatcher (for plugins that add CLI commands).
    pub cli: CommandDispatcher,
}
```

### 4.4 Frontend Plugin API (TypeScript)

```typescript
// crates/minotes-app/src/plugin-api/index.ts

interface PluginAPI {
  // Data operations (permission-gated)
  pages: {
    list(filters?: PageFilter): Promise<Page[]>;
    get(id: string): Promise<PageTree>;
    create(title: string, props?: PageProps): Promise<Page>;
    update(id: string, updates: Partial<Page>): Promise<Page>;
    delete(id: string): Promise<void>;
  };

  blocks: {
    create(pageId: string, content: string, opts?: BlockOpts): Promise<Block>;
    update(id: string, content?: string, props?: Partial<BlockProps>): Promise<Block>;
    delete(id: string): Promise<void>;
    getChildren(id: string): Promise<Block[]>;
  };

  // Events
  events: {
    subscribe(eventTypes: string[], callback: (event: PluginEvent) => void): () => void;
  };

  // Storage
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };

  // UI extension points
  ui: {
    registerView(view: PluginView): void;
    registerCommand(command: PluginCommand): void;
    registerSlashCommand(pattern: string, handler: SlashHandler): void;
    addContextMenuItems(items: ContextMenuItem[]): void;
  };

  // Settings
  settings: {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
    onChange(key: string, handler: (value: unknown) => void): void;
  };
}
```

### 4.5 Permission Enum

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Permission {
    PagesRead,
    PagesWrite,
    BlocksRead,
    BlocksWrite,
    PropertiesRead,
    PropertiesWrite,
    EventsRead,
    EventsSubscribe,
    StorageReadWrite,
    FileSystemRead,     // For CSS snippets reading files
    FileSystemWrite,    // For plugins that write files
    NetworkRequest,     // For plugins making HTTP calls
    CustomView,         // For injecting UI
    CliCommand,         // For registering CLI subcommands
    EditorHook,         // For intercepting editor operations
    GraphAccess,        // For graph visualization plugins
}
```

## 5. Runtime Design

### 5.1 PluginHost Lifecycle

```
App start
  │
  ▼
PluginHost::new()
  1. Load manifests from plugin_storage
  2. Validate all manifests
  3. Create Plugin instances
  │
  ▼
PluginHost::init()
  4. Call plugin.init() for all plugins
  5. Register Tauri commands from plugins
  6. Subscribe event bus for plugin subscriptions
  │
  ▼
PluginHost::enable_all()
  7. For each enabled plugin: plugin.on_enable()
  8. Register Tauri commands
  9. Subscribe event bus
  │
  ▼
Runtime
  10. Event routing: events → subscribers
  11. Tauri cmd → plugin handler
  12. Frontend bridge
  │
  ▼
App shutdown
  13. For each enabled: plugin.on_shutdown()
  14. Deregister commands
```

### 5.2 Event Routing

Events flow through the `events` table as they do today. The key addition: each plugin declares which event types it subscribes to in its manifest. The `PluginHost` maintains an event-to-plugin index:

```
block.created ──► srs-cards (wants new blocks for card creation)
                ──► graph-view (wants to update link graph)
                ──► template-plugin (wants to apply templates)

page.deleted ──► trash-plugin (wants to archive)
                ──► graph-view (wants to remove nodes)

card.reviewed ──► srs-cards (FSRS state update)
                ──► analytics-plugin (tracks review stats)
```

This is implemented as an in-memory index maintained by `PluginHost`, rebuilt on each enable/disable. The existing event emission pattern in `repo/` methods remains unchanged -- we simply add a `PluginHost::notify(event)` call after each `emit_event` in the mutation paths.

### 5.3 Plugin Discovery and Loading

**Core plugins** (srs-cards, css-snippets, graph-view, pdf-viewer, templates) are registered at compile time via a macro:

```rust
// In minotes-core/src/plugin/core_registry.rs
plugin_registry! {
    register!(SrsCardsPlugin);
    register!(CssSnippetsPlugin);
    register!(GraphViewPlugin);
    register!(PdfViewerPlugin);
    register!(TemplatesPlugin);
}
```

**Native plugins** (third-party `.so`/`.dll`/`.dylib`) are discovered from:
- `$XDG_DATA_HOME/minotes/plugins/` (user-level)
- The project directory's `.minotes/plugins/` (graph-level)

Discovery scans for `minotes-plugin.json` manifest files, loads the shared library via `libloading`, and instantiates the plugin.

**Frontend plugins** are loaded dynamically from:
- The same directories as native plugins
- The `plugin_storage` table (for plugins installed from a future marketplace)

### 5.4 Storage Model

The existing `plugin_storage` table is extended with a `plugin_id` column to namespace key-value pairs:

```sql
ALTER TABLE plugin_storage ADD COLUMN plugin_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_plugin_storage_plugin ON plugin_storage(plugin_id, storage_key);
```

This gives each plugin its own storage namespace. The migration script copies existing data (`plugin_id = ''` means "global" storage, kept for backward compatibility).

## 6. Migration Plan

### 6.1 Phase 0: Database Migration

**Action:** Add `plugin_id` column to `plugin_storage` table.

**Migration:** Run on app startup if version indicates pre-migration state. Copy existing `plugin_storage` rows with `plugin_id = ''` to a default namespace. No data loss.

### 6.2 Phase 1: Extract SRS Cards as First Plugin

**Why SRS cards first?**
- Fully isolated: own table, own models, no cross-dependencies (confirmed in `cards.rs`)
- Backend fully implemented: the FSRS algorithm, card CRUD, due-card queries all exist
- UI already exists: `ReviewPanel` component is complete
- The only missing piece is card creation wired to the frontend
- Natural fit: it is a self-contained domain with clear lifecycle (cards exist, are reviewed, expire)

**Steps:**
1. Create `crates/minotes-core/src/plugin/builtins/srs_cards.rs` implementing the `Plugin` trait
2. The plugin's `init()` registers no new Tauri commands (existing `get_due_cards`, `review_card`, `create_card`, `get_srs_stats` commands already work -- they are just called directly, not through a plugin-registered handler). Instead, the plugin registers itself in the core plugin registry and is marked `enabled: true` by default.
3. Extract the card creation workflow: the ReviewPanel currently has no way to create cards from blocks. The plugin adds a `create_card_from_block` Tauri command (wrapping the existing `create_card` in `cards.rs`).
4. Add a "Create Flashcard" button to block context menus (frontend), which calls the plugin's command.
5. Wire the plugin manifest into the `plugins` table via a one-shot migration script.

**What changes in `minotes-core`:**
- New module `plugin/mod.rs` with trait and context
- New module `plugin/builtins/mod.rs` and `plugin/builtins/srs_cards.rs`
- `plugin_registry!` macro for compile-time registration
- `cards.rs` methods remain unchanged -- the plugin just wraps them

**What changes in `minotes-app` (Tauri lib):**
- `lib.rs`: `PluginHost` initialization in `setup_app()`, shutdown in cleanup
- No change to existing `get_due_cards`, `review_card`, `create_card` Tauri commands -- they stay as-is for backward compatibility with CLI
- New command `register_plugin_commands` called during `PluginHost::init()` to register any plugin-exposed commands

**What changes in frontend:**
- ReviewPanel gets a "Create Card" option on block selection
- Settings panel gets a "Plugins" tab listing enabled/disabled core plugins
- The existing `PluginManager` modal is repurposed: it now shows plugin status, not dead metadata

### 6.3 Phase 2: Extract CSS Snippets as Second Plugin

**Why CSS snippets next?**
- Purely a UI concern: `snippets.rs` has zero cross-dependencies
- Self-contained: own table, own model, no links to pages/blocks
- Already works end-to-end: `CssSnippetManager` UI exists, `cssLoader.ts` applies CSS, `snippets.rs` has full CRUD
- Easy to disable: users who don't use custom CSS can disable this plugin

**Steps:**
1. Create `plugin/builtins/css_snippets.rs`
2. The plugin's `init()` hooks into the frontend CSS injection pipeline by emitting a Tauri event (`css-snippets-changed`) when snippets are modified
3. The frontend `cssLoader.ts` subscribes to this event and re-injects CSS
4. The plugin registers itself as enabled by default
5. Same migration approach as Phase 1

### 6.4 Phase 3: Unified Plugin UI and Settings

**Steps:**
1. Replace the existing `PluginManager` component with a proper plugin management interface showing:
   - Plugin name, version, type (core/native/frontend)
   - Enabled/disabled toggle
   - Storage usage
   - Permissions granted
   - Event subscriptions
2. Repurpose the `ObsidianPluginBrowser` as a legacy compatibility tab within the same UI
3. Add plugin CRUD commands to the Tauri command list

### 6.5 Phase 4: Third-Party Plugin Loading

**Steps:**
1. Implement `libloading`-based plugin discovery from standard directories
2. Add `register_native_plugin` Tauri command that:
   - Validates the manifest JSON
   - Stores the manifest in `plugin_storage`
   - Copies the shared library to the plugin directory
   - Registers the plugin in the `plugins` table
   - Calls `PluginHost::register_and_enable(plugin)`
3. Add a "Install Plugin" button to the plugin management UI (drag-and-drop a `.minotes-plugin` archive or browse to a directory)

### 6.6 Phase 5: Frontend Plugin API + Graph View Extraction

**Steps:**
1. TypeScript PluginAPI library for frontend plugins
2. Frontend plugin loader in the browser (dynamic import from plugin directory)
3. Graph view extracted as `GraphViewPlugin`
4. Plugin API documentation

### 6.7 Phase 6: Marketplace (Deferred)

A marketplace is not included in the initial rollout. The infrastructure (manifest validation, version checking, plugin storage) is built in Phase 4. The marketplace layer (remote registry, install from URL, version update) is a separate P2 feature that builds on the foundation.

## 7. Sandboxing and Security

### 7.1 Permission Enforcement

Each plugin declares permissions in its manifest. The `PluginContext` wraps the database with permission checks:

```rust
impl DatabaseRef {
    pub fn with_permission(&self, permission: Permission) -> Result<DatabaseRef> {
        if !self.granted_permissions.contains(&permission) {
            return Err(Error::PermissionDenied(permission));
        }
        Ok(self.clone())
    }
}
```

Core plugins are pre-approved (all permissions granted). Third-party plugins only get what they declare, validated at install time.

### 7.2 Storage Isolation

Each plugin's `plugin_storage` namespace is isolated. Plugin A cannot read Plugin B's data. The `plugin_id` column in `plugin_storage` enforces this at the query level.

### 7.3 Frontend Plugin Security

Frontend plugins loaded from the browser:
- Run in the same origin as the app (Tauri window)
- Cannot access the filesystem without explicit permission grants
- Communicate with the backend exclusively through Tauri commands (not direct Rust calls)
- Are sandboxed via Tauri's built-in permission system (already configured in `src-tauri/tauri.conf.json`)

## 8. Success Criteria

### Phase 1 Success Criteria
- [ ] `Plugin` trait compiles and `PluginHost` initializes without errors
- [ ] SRS cards work identically to before (same data, same ReviewPanel UI)
- [ ] Card creation works from frontend (context menu or button)
- [ ] `plugins` table contains the SRS cards plugin entry
- [ ] Disabling the SRS cards plugin removes the review panel from the UI
- [ ] All existing Tauri commands (`get_due_cards`, `review_card`, etc.) still work
- [ ] Plugin icon bar appears in sidebar stats-bar with SRS cards icon
- [ ] Hovering over SRS icon shows tooltip with plugin name
- [ ] Clicking SRS icon opens action menu with "Open Review Panel" command
- [ ] Plugin actions appear in command palette (`>` mode)

### Phase 2 Success Criteria
- [ ] CSS snippets work identically to before
- [ ] Enabling/disabling snippets plugin toggles CSS injection
- [ ] Modifying snippets in the manager triggers live CSS reload without page refresh
- [ ] `plugins` table contains both SRS and snippets plugins

### Phase 3 Success Criteria
- [ ] Single plugin management UI shows all registered plugins
- [ ] Enable/disable toggles work for all plugins
- [ ] Plugin storage is viewable and editable per plugin
- [ ] Obsidian plugin browser is accessible as a compatibility tab

### Phase 4 Success Criteria
- [ ] Third-party `.so`/`.dll` plugins can be installed via drag-and-drop
- [ ] Manifest validation rejects malformed plugins
- [ ] Plugin uninstall cleans up storage and deregisters commands
- [ ] Installed plugins survive app restart

### Long-Term Success Criteria (Phase 5+)
- [ ] Frontend plugins can register custom views in the sidebar and main content area
- [ ] Plugin API provides typed, documented interface for all MiNotes operations
- [ ] Marketplace infrastructure (manifest registry, version checking) is in place
- [ ] Plugin authoring documentation is available

## 9. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing Tauri commands during refactor | High | Keep all existing commands as-is; plugin-registered commands are additive |
| PluginHost initialization failure blocks app startup | High | PluginHost init is best-effort; a failing plugin logs a warning and skips, never crashes the app |
| `libloading` ABI compatibility across platforms | Medium | Restrict to C ABI only; require plugins to be compiled with same Rust toolchain as MiNotes |
| Frontend plugin performance degrading UI | Medium | Load frontend plugins lazily (on demand, not on app start); cap execution time |
| Existing `ObsidianPluginBrowser` users lose functionality | Medium | Keep Obsidian compatibility tab during transition; provide migration guide |

## 10. Key Files

### New files to create:
- `crates/minotes-core/src/plugin/mod.rs` -- Plugin trait, PluginContext, PluginHost
- `crates/minotes-core/src/plugin/builtins/mod.rs` -- Built-in plugin registry
- `crates/minotes-core/src/plugin/builtins/srs_cards.rs` -- SRS cards plugin
- `crates/minotes-core/src/plugin/builtins/css_snippets.rs` -- CSS snippets plugin
- `crates/minotes-core/src/plugin/loader.rs` -- Native plugin loader (Phase 4)
- `crates/minotes-app/src/components/PluginBar.tsx` -- Plugin icon bar component (Phase 1)
- `crates/minotes-app/src/plugin-api/index.ts` -- Frontend plugin API (Phase 5)
- `crates/minotes-app/src/plugin-api/types.ts` -- Frontend plugin types (Phase 5)
- `crates/minotes-app/src/plugin-api/loader.ts` -- Frontend plugin loader (Phase 5)

### Existing files to modify:
- `crates/minotes-core/src/lib.rs` -- Add plugin module
- `crates/minotes-core/src/db.rs` -- Migration for plugin_storage (add plugin_id column)
- `crates/minotes-app/src-tauri/src/lib.rs` -- PluginHost init, Tauri command registration
- `crates/minotes-app/src/components/PluginManager.tsx` -- Repurpose for actual plugin management
- `crates/minotes-app/src/components/ReviewPanel.tsx` -- Add card creation button
- `crates/minotes-app/src/lib/api.ts` -- Plugin CRUD API methods
- `crates/minotes-core/Cargo.toml` -- Add `libloading`, `semver`, `async-trait` dependencies