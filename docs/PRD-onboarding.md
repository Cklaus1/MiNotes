# PRD: First-run onboarding

Status: proposal · Written 2026-11-17

## 1. Overview

A single welcome screen, shown once, to someone who has just installed MiNotes
from GitHub Releases (Windows or Linux; Android gets a shorter variant, §3.7).
It asks one question, "How do you want to start?", and offers three paths:

1. **Start fresh**: a new notebook and the Getting Started tour.
2. **Import my notes**: Evernote (.enex), Obsidian vault, markdown folder.
3. **Join a synced notebook**: set up git sync from another device.

**One-liner:** the first thing a new user sees is a choice of where their notes
come from, not an empty page.

### Why

- Today a new install silently creates a "Getting Started" page in the default
  notebook (`App.tsx` init effect, `lib/onboarding.ts`). A switcher who wants
  their Evernote notes must find notebook menu → "Import from other apps…"
  alone; someone with a second computer must find "Join an existing notebook…",
  and is left with a throwaway Getting Started page that only gives way to the
  pulled pages through the C-9 workaround (`mark_onboarding_seed`,
  `repo/onboarding.rs`).
- The importer is a hook for switchers and is now proven: it was validated on
  large real-world Evernote exports. Nothing in the first minute says so.
- The "done" flag is `localStorage["minotes-onboarding-complete"]`: per
  webview, not per notebook or machine. Clearing site data re-creates
  "Getting Started" in a notebook full of notes.

## 2. Goals and non-goals

Goals
1. Three clear ways in, with Import as prominent as Start fresh.
2. Never shown to anyone who already has notes, another notebook, or has seen it.
3. Every path ends in the app with a sensible first view and no half-made state;
   cancelling any path returns to the choice screen having written nothing.
4. Reachable later: palette command and a Help entry.
5. Keyboard- and screen-reader-complete; works offline (except Join).

Non-goals (v1)
- Accounts, sign-in, or any network call before the user chooses Join.
- A multi-step wizard, theme picker or feature carousel. The tour is the
  Getting Started page.
- Telemetry or funnel analytics (§8).
- Importers beyond the three that exist.

## 3. User-facing behaviour

### 3.1 The welcome screen

A full-window screen (not a dialog over an empty app), shown before a notebook
is opened in the UI. The default notebook exists on disk (`startup_notebook`) but
nothing is written to it until a path completes.

```
                       Welcome to MiNotes
          Your notes live on this computer, in files you own.

 +----------------------+ +----------------------+ +----------------------+
 |  [file-plus]         | | [download]           | |  [refresh]           |
 |  Start fresh         | | Import my notes      | |  Join a synced       |
 |                      | | (Popular with people | |  notebook            |
 |  A new notebook and  | |  switching)          | |  Already use MiNotes |
 |  a short tour.       | | From Evernote,       | |  on another device?  |
 |                      | | Obsidian or a folder | |  Connect to it.      |
 |  [ Start fresh ]     | | of markdown.         | |  [ Join notebook ]   |
 |                      | |  [ Import notes ]    | |                      |
 |                      | |  How well does it    | |                      |
 |                      | |  work?               | |                      |
 +----------------------+ +----------------------+ +----------------------+

     Have a MiNotes .zip?  Open a notebook .zip          Skip, just let me in
```

- Three equal cards (stacked below 700 px). Import's prominence comes from the
  tag, the copy and its position in the middle, not size (Q1).
- **How well does it work?** is a disclosure: "Tested on large real-world Evernote
  exports. Keeps notebooks, tags, dates and attachments." (Q6)
- **Open a notebook .zip** runs `importNotebookFromZip()` (`lib/notebooks.ts`),
  then ends onboarding. Only when `caps.notebook_zip`.
- **Skip, just let me in** opens the default notebook with the Getting Started
  page (today's behaviour) and marks onboarding done. Always visible.
- Window title: "Welcome — MiNotes" (`lib/windowTitle.ts`).

### 3.2 Start fresh

**Start fresh** opens step 2 in the same screen:

```
  <- Back                       Name your notebook
  Name   [ My Notes                         ]
  > More options
      Where   ~/MiNotes/My Notes          [ Change… ]
      [ ] Encrypt this notebook with a passphrase
  <why Create is disabled, if it is>            [ Create notebook ]
```

- It is `NewNotebookDialog`'s form (`components/NotebookDialogs.tsx`) without
  the Modal: same `nameProblem`, default location `~/MiNotes/<name>`,
  `pickFolder`, cloud-folder warning (`cloudName`), `passphraseProblem`,
  `PassphraseFields`. Name defaults to "My Notes" (Q2, Q9).
- **Create notebook**: creates the notebook (`notebooks::create_notebook`),
  switches to it, seeds Getting Started (the existing `TUTORIAL_BLOCKS` +
  `mark_onboarding_seed`) and opens that page. An encrypted notebook shows
  `RecoveryKeyModal` first.
- **Change…**: native folder picker. **Back**: to §3.1, nothing written.

### 3.3 Import my notes

**Import notes** opens the existing import dialog; the importer is reused, not
rebuilt (`ImportDialog` already does source pick, preview before writing,
split mode, "A new notebook named …", result summary).

- The card calls `openImport()` (`OPEN_IMPORT`, `lib/importPicks.ts`). Because no
  App is mounted yet, `ImportMount` must be mountable by the welcome host (§5).
- Three source links on the card (**Evernote (.enex)**, **Obsidian vault**,
  **Markdown folder**) call `openImport("evernote" | "obsidian" | "markdown")`
  so the source step is skipped.
- Destination is forced to **a new notebook**, name pre-filled ("Evernote",
  or the vault's folder name). There is no existing notebook to import into.
- Result: the dialog's summary ("Imported into the new notebook X, which is now
  open"), then the app. No Getting Started page is added to an imported
  notebook; the tour is in Help (§3.6) (Q5).
- Cancel returns to §3.1. A failed import does not complete onboarding and
  deletes the half-made notebook; the user is back at the choice with the
  dialog's error (Q8).
- Big imports show the dialog's own progress; the welcome screen is inert behind it.

### 3.4 Join a synced notebook

**Join notebook** shows the `JoinNotebookDialog` fields inline: remote address
(`RemoteAddressField`), notebook name, and, once the remote proves encrypted
(`isEncryptedRemote`), passphrase or recovery key.

- **Join**: `api.joinNotebook`, `switchNotebook`, `gitSyncEnable`, under
  `withBusy("Joining …")`, exactly as the dialog does.
- No Getting Started page: the pulled notebook is the content (this removes the
  C-9 case at its source for first-run joins).
- Errors reuse `remoteError` (offline, not found, auth) with Retry. Credentials
  are never asked for: git's own agent / credential helper (`CREDENTIALS_NOTE`
  one-liner on screen).
- "Where do I find the address?" disclosure: Settings → Sync & Backup on the
  other device.
- Offline: the button stays enabled; the error reads "Can't reach the remote.
  Check your connection", nothing is created.

### 3.5 Who sees it, and who never does

Decided in the backend, not by `localStorage`. Shown only when **all** hold:

1. The default notebook is the only notebook and is the active one
   (`~/.minotes/active_graph` absent or default).
2. It has no user content: no live page, trash, archive or journal entry.
3. `ui_state["onboarding-done"]` is unset.

Never shown when: the legacy `localStorage` flag is set (skips the call), any
content or other notebook exists (every upgrader), a notebook was selected
through `--notebook` or a link, or the notebook is locked (the lock screen wins).

Done is `ui_state["onboarding-done"]="1"` in the default notebook plus the
legacy key (downgrade safety). New commands: `get_onboarding_state`
(`{ show }`) and `mark_onboarding_done`. An emptied notebook counts as fresh
again only if the ui_state key is also gone (Q3).

### 3.6 Reopening it later

| Where | What |
|---|---|
| Palette | **Welcome: show the start screen** (`lib/appCommands.ts`; keywords "onboarding first run new") |
| Palette | **Getting Started tour** (opens the page; re-creates it if trashed) |
| Help (app menu / sidebar, beside Keyboard shortcuts Ctrl+/) | "Welcome screen…", "Getting Started tour" |
| Notebook menu | New notebook…, Import from other apps…, Join an existing notebook… stay as they are |

Reopened inside a working app it is an overlay: Start fresh opens New notebook,
Import and Join open their dialogs, **Skip** becomes **Close**.

### 3.7 Android differences

Per CLAUDE.md "Android" and PRD-notebooks §11:

- Gate everything on `useCapabilities()`, never the user agent.
- No Where row, no "Open a notebook .zip" unless `choose_location` /
  `notebook_zip`. Notebooks live in app storage; Start fresh asks only for a
  name (and a passphrase if encryption is ticked; no keychain, `keychain` false).
- Import is shown only when `import_from_files` is true. On Android it is not,
  so the card says "Import is available in the desktop app. Sync a notebook
  from your computer instead", with Join as the route (Q4).
- SQLite never runs on a picked `content://` URI; the picker is only for copies.
- Cards stack; touch targets at least 48 dp.

## 4. Keyboard and accessibility

- The welcome screen is the page: `<main>` with one `<h1>`, each card a
  `<section>` labelled by its heading. The reopened overlay uses `Modal` +
  `useDialogFocus` (`role="dialog"`, `aria-modal`).
- Initial focus: **Start fresh**. Tab order: Start fresh, Import notes and its
  three source links, Join notebook, zip link, Skip.
- **1 / 2 / 3** pick a card (hint shown). Enter activates a focused button.
  **Esc** goes back one step; on the overlay's choice step it closes
  (`useLayer`, `lib/layers.ts`); on true first run it does nothing.
- Busy via `withBusy`; errors in `role="alert"`; a disabled **Create notebook**
  or **Join** says why in `.disabled-reason`.
- Colours only from theme tokens, follows the system theme, icons from
  `lib/icons.ts` (no emoji), usable at 200 % zoom and 360 px wide.

## 5. Design notes (for the implementer)

- **Host:** new `components/Welcome.tsx` (exports only the component; logic in
  `lib/onboardingFlow.ts`, copy in `lib/onboardingCopy.ts`). Order in
  `main.tsx` / `LockGate`: locked first, then `get_onboarding_state`, then App.
- **Remove** the silent seed from the `App.tsx` init effect (~lines 1470–1484).
  Move it to `seedGettingStarted()` in `lib/onboarding.ts`, called by Start
  fresh, Skip and the palette tour command (idempotent).
- **State:** `choice | fresh | joining` in one `useReducer`; Import hands off
  to `ImportDialog`.
- **Reuse, don't fork:** extract `NewNotebookForm` and `JoinNotebookForm`
  (exported components in their existing files; the dialogs wrap them in
  `Modal`). Validation stays single-sourced (`nameProblem`, `passphraseProblem`,
  `remoteError`, `isEncryptedRemote`).
- **Import host:** mount `ImportMount` beside Welcome in `main.tsx`, or inline;
  after success the same `NOTEBOOK_SWITCHED` flow App uses must run.
- **Atomicity:** nothing is written until a path's final button. Import and Join
  create *new* notebooks, so a failure is cleaned up by deleting that notebook.
- **Backend:** `get_onboarding_state` / `mark_onboarding_done` in
  `repo/onboarding.rs` beside `mark_onboarding_seed`; Tauri commands go through
  `state.db_guard()?`.
- **Browser mode:** the mock seeds 6 pages, so §3.5 hides the screen by
  default; add `window.__MINOTES__.resetForOnboarding()` to empty the mock.

## 6. Phases

1. **MVP**: backend state + done; `Welcome` with three cards; Start fresh (name
   + defaults + Create); Import via `openImport` into a new notebook; Join inline;
   Skip; the existing-user guard; remove the silent seed.
2. **Entry points and polish**: palette + Help entries, reopen overlay; More
   options (location, encryption, cloud warning); zip link; Android variant.
3. **Later**: "what's next" strip after an import; localisation.

## 7. Testing

Browser journeys (mock; next free is **117**):

- **117. First run shows the choice**: reset mock to empty; welcome visible,
  focus on Start fresh, title "Welcome — MiNotes", nothing written yet.
- **118. Start fresh**: Create with defaults; Getting Started has the tour blocks,
  seed recorded, no welcome after reload; Back writes nothing; invalid name
  disables Create with a reason.
- **119. Import path**: each source opens the dialog at the right step with
  "new notebook"; cancel returns; success opens the notebook with no tour page.
- **120. Join path** (`mockSync` / `mockRemotes`): plain joins; encrypted asks
  for the passphrase; bad address errors and creates nothing.
- **121. Never twice / never for existing users**: a page, a second notebook or
  the legacy flag hides it; Skip marks it done.
- **122. Reopen**: palette and Help show the overlay; Esc closes it; the tour
  command re-creates a trashed page.
- **123. Keyboard and a11y**: 1/2/3, Tab order, Esc steps back, one `h1`.

Desktop journeys (real backend, throwaway HOME; next is **D26**):

- **D26. Clean first launch**: Welcome shown; Start fresh by real typing creates
  `~/MiNotes/My Notes/`; restart does not show it; a second clean HOME takes Skip.
- **D27. Import on first run**: an `.enex` fixture (from the import tests)
  through real clicks; folder and page count checked in the DB; CLI `page list`
  agrees.
- **D28. Join on first run**: a second HOME with a shared bare remote (as D20),
  plain and encrypted; both databases compared.
- **D29. Upgrade guard**: a HOME with pages but no localStorage flag never shows it.

Unit: `get_onboarding_state` truth table (Rust); `seedGettingStarted`
idempotence; a source lint that `App.tsx` no longer seeds on its own.
Android: manual emulator pass (no Where row, no zip link, import card replaced).

## 8. Success measures (local only, no telemetry)

- Journeys 117–123 and D26–D29 pass in CI and nightly.
- A new user reaches an open page in at most 3 clicks on Start fresh and Skip;
  no scrolling at 1280x720 or 360x640 (asserted in a journey).
- No Cancel or failure leaves an empty or half-imported notebook (notebook-list
  assertions).
- Zero upgraders see it (D29).
- `desktop-check/ux-tour.sh` screenshots of every step reviewed in the next UX
  review.

The app never counts which card is picked. A signal, if wanted, can only be an
opt-in, user-initiated "send feedback" link.

## 9. Open questions

1. **Focus and visual weight?** (a) Start fresh focused, Import tagged "Popular
   with people switching"; (b) Import larger; (c) order by detected state.
   **Recommend (a):** safest default; the tag and copy do the promotion.
2. **How much setup on Start fresh?** (a) name only; (b) full form always;
   (c) name plus a "More options" disclosure. **Recommend (c):** one click for
   most, full control one click away.
3. **Where does "done" live?** (a) `localStorage`; (b) `ui_state` in the default
   notebook; (c) a file in `~/.minotes/`. **Recommend (b)** plus the legacy flag as
   an "already done" hint: survives webview resets, per machine, never synced.
4. **Import on Android?** (a) hide the card, point to Join/zip; (b) enable via
   the picker's copy path; (c) show it disabled with a reason. **Recommend (a)**
   with (c)'s wording: storage rules forbid reading a picked folder.
5. **Tour page in an imported notebook?** (a) never; (b) always; (c) checkbox on
   the result. **Recommend (a):** do not add pages to a notebook of thousands
   the user wrote; Help has the tour.
6. **How to say the importer is proven?** (a) the number on the card; (b) a "How
   well does it work?" disclosure; (c) no claim. **Recommend (b):** concrete but
   not billboard copy; re-run the corpus whenever the importer changes so the
   claim stays true.
7. **Is Skip allowed on first run?** (a) always; (b) never; (c) after the first
   card interaction. **Recommend (a):** it equals today's behaviour and traps no one.
8. **After a failed or cancelled Import/Join?** (a) not done, back to the choice;
   (b) done, open the empty default; (c) ask. **Recommend (a):** the user came
   to bring notes in.
9. **Default name and location?** (a) "My Notes" in `~/MiNotes/`; (b) legacy
   `~/.minotes/default.db`; (c) ask every time. **Recommend (a):** matches
   `minotes notebook create` and PRD-notebooks §9.1; folder notebooks give the
   markdown copy and sync for free.
10. **An empty legacy default notebook already on disk?** (a) reuse it for Start
    fresh; (b) leave it and create a new one; (c) offer to delete it.
    **Recommend (b):** harmless, removable in Manage notebooks; Import and Join
    always create new notebooks anyway.

## Sources

`CLAUDE.md`; `docs/PRD-import.md`, `PRD-notebooks.md` (§9, §11),
`PRD-git-sync.md`, `PRD-encryption.md`, `PRD-tabs.md` (format);
`crates/minotes-app/src/App.tsx` (first-run effect), `lib/onboarding.ts`,
`lib/importPicks.ts`, `components/ImportDialog.tsx`, `NotebookDialogs.tsx`,
`JoinNotebookDialog.tsx`, `NotebookSwitcher.tsx`;
`crates/minotes-core/src/repo/onboarding.rs`; `src-tauri/src/lib.rs`
(`startup_notebook`).
