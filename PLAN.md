# harness — Implementation Plan

> An agent harness control surface built entirely on Stacks, stx and Craft.
> Target: strictly better than [t3code](https://github.com/pingdotgg/t3code) on the control-surface
> axis, and architecturally ready to absorb [pi](https://github.com/earendil-works/pi)'s runtime
> later without a rewrite.

---

## Table of contents

1. [Positioning and scope](#1-positioning-and-scope)
2. [Toolchain and version policy](#2-toolchain-and-version-policy)
3. [Architecture](#3-architecture)
4. [Repo layout](#4-repo-layout)
5. [Data model](#5-data-model)
6. [The contract: commands and events](#6-the-contract-commands-and-events)
7. [The driver layer](#7-the-driver-layer)
8. [Surfaces](#8-surfaces)
9. [Profiles and the Arc sidebar](#9-profiles-and-the-arc-sidebar)
10. [Upstream fixes — at the source](#10-upstream-fixes--at-the-source)
11. [Performance budgets](#11-performance-budgets)
12. [Security model](#12-security-model)
13. [Testing strategy](#13-testing-strategy)
14. [CI and release](#14-ci-and-release)
15. [Milestones](#15-milestones)
16. [Risks](#16-risks)
17. [Deferred: the runtime](#17-deferred-the-runtime)
18. [Conventions](#18-conventions)

---

## 1. Positioning and scope

| | t3code | pi | harness |
|---|---|---|---|
| Shape | Control surface over other CLIs | Own agent runtime + TUI | **Control surface now, runtime later** |
| Stack | pnpm · Node 24 · Effect · React · Electron · Vite | npm · Node 22 · TS · custom TUI | **Bun 1.3.14 · Stacks · stx · Craft** |
| Deps | thousands transitive | hundreds transitive | **first-party only (`~/Code/**`)** |
| Desktop | Electron (~150MB, ~1–2s cold start) | none | **Craft/Zig (~1.4MB core, <100ms cold start)** |
| Server | Effect RPC over WebSocket | custom CBOR protocol | Stacks realtime + HTTP, CBOR frames |
| Sidebar | flat project list | n/a | **Arc spaces — swipeable, tinted profiles** |
| Mobile | React Native | n/a | Craft iOS/Android (M7) |

The wedge is the same one Craft has over Electron: a native shell measured in megabytes and
milliseconds, driving the same agent CLIs everyone else drives. The differentiator on top of that is
the Arc-theme sidebar — workspaces as *scenes* you swipe between, each with its own colour, sessions
and agents. Neither t3code nor pi has anything like it.

### Scope decision

**In scope (v1):** control surface only. harness spawns and supervises *existing* agent CLIs —
Claude Code, Codex, Cursor, OpenCode, Grok — and renders their sessions.

**Out of scope, documented for later:** our own agent loop and multi-provider AI layer. See
[§17](#17-deferred-the-runtime). Every boundary below is drawn so a first-party runtime becomes
*one more driver kind*, not a refactor.

---

## 2. Toolchain and version policy

**Bun 1.3.14, exactly, everywhere.** 1.4.0 ships next week; we do not adopt it until deliberately.
This is not a preference — there is a live footgun here that has already bitten Stacks.

### The pitfall, concretely

Bun 1.4.x writes `bun.lock` with `"lockfileVersion": 2`. Bun 1.3.x cannot parse it and dies at
`bun install --frozen-lockfile` with `Unknown lockfile version`. Stacks already has a guard for this
(`.github/scripts/check-lockfile-version.ts`, `EXPECTED_LOCKFILE_VERSION = 1`) and its error message
documents the whole failure mode.

Current state of this machine and these repos:

| Where | Declares | Actual / effect |
|---|---|---|
| `~/.bun/bin/bun` | — | **1.4.0** — the default `bun` on PATH |
| `stacks/deps.yml` | `bun: ^1.3.14` | caret allows `<2.0.0`, so **1.4.0 satisfies it** |
| `stx/deps.yaml` | `bun.sh: ^1.3.14` | same — no real pin |
| `craft/deps.yaml` | `bun.sh: ^1.3.14` | same |
| `craft/pantry.jsonc` | `"bun.sh": "latest"` | **actively resolves to 1.4.0** |
| all three `bun.lock` | `lockfileVersion: 1` | still correct, but one stray `bun install` away from v2 |

So today, a plain `bun install` in stx or craft on this machine runs 1.4.0, rewrites the lockfile to
v2, and breaks their CI. That is exactly the class of pitfall to close before writing any harness
code.

### Policy

1. **harness `deps.yml` pins exactly:**
   ```yaml
   dependencies:
     bun.sh: 1.3.14
     git-scm.org: ^2.47.0
     sqlite.org: ^3.47.2
   ```
   Exact, not caret. When we move to 1.4.x it is a deliberate one-line commit plus a lockfile
   regeneration plus a guard bump — never an accident.

2. **`package.json` declares `"engines": { "bun": "1.3.14" }`** so the intent is visible to anyone
   reading the manifest, not only to pantry.

3. **Port the lockfile guard** into `harness/.github/scripts/check-lockfile-version.ts` with
   `EXPECTED_LOCKFILE_VERSION = 1`, and run it in CI *before* install.

4. **Always work inside the pantry environment**, so `bun` resolves to the pinned 1.3.14 rather than
   `~/.bun/bin/bun`:
   ```bash
   eval "$(pantry env)"
   bun --version   # must print 1.3.14
   ```
   Craft's own scripts already do this (`eval "$(pantry env | sed -n '/^export /,$p')"` before every
   `zig build`). We adopt the same discipline for `bun`.

5. **A `bun --version` assertion in `./buddy doctor`-equivalent and in CI.** If the running Bun is
   not 1.3.14, fail loudly with the fix, rather than producing a subtly different artifact.

6. **Escape hatch when the environment is wrong:** `bunx bun@1.3.14 install` — the exact remedy the
   Stacks guard prints.

### Two hazards found while applying this

**`pantry install` in `~/Code/stacks` is not side-effect-free.** It runs a post-install hook that
shells out to `buddy migrate` and seeds the dev database. Observed: six `@generated` migration files
written into `database/migrations/` and a 408-line rewrite of
`storage/framework/database/model-snapshot.sqlite.json`. All regenerable, none related to the
install — but if you don't notice, they end up in your next commit. Prefer `pantry env` (which only
resolves the toolchain) over `pantry install` unless you actually intend to reinstall, and check
`git status` afterwards when you do.

**Floating ranges are not a Bun-only problem.** The first `pantry install` in craft silently moved
Zig from `0.17.0-dev.1509_bb296ab9b` to `dev.1606_a06534d73`, because `^0.17.0-dev` floats on a *dev*
channel. That is a compiler swap under a native build. Zig is now pinned exactly in
`craft/deps.yaml` and `craft/pantry.jsonc` at the version v0.0.58 was released with. Audit any other
floating range in these repos before trusting a build.

### Upstream consequence

The caret ranges in stx and craft, and craft's `"bun.sh": "latest"`, are part of §10 — they get
tightened at the source before we depend on those packages. See [§10.7](#107-stx--craft--stacks--bun-ranges-do-not-actually-pin).

### Other toolchain versions

| Tool | Pin | Why |
|---|---|---|
| Bun | `1.3.14` exact | above |
| SQLite | `^3.47.2` | Stacks floor |
| git | `^2.47.0` | Stacks floor |
| Zig | `^0.17.0-dev` | craft only; harness never builds Zig directly except when working on §10.1/§10.2 |
| TypeScript | via `better-dx` | do not declare separately |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Surfaces                                                     │
│   desktop  — Craft window over stx SSR          (M4, primary)│
│   web      — same stx views, Stacks server              (M3) │
│   cli      — ./harness, thin client of the server       (M2) │
│   mobile   — Craft iOS/Android                          (M7) │
│                                                              │
│   shared:  resources/views/**  ·  packages/client            │
└──────────────────────┬───────────────────────────────────────┘
                       │  Stacks realtime (WS) + HTTP
                       │  contract: packages/contract  (CBOR frames)
┌──────────────────────▼───────────────────────────────────────┐
│ harness server  (Bun, Stacks app)                            │
│   • event-sourced session engine (single ordered queue)      │
│   • driver registry: claude · codex · cursor · opencode · grok│
│   • profile / workspace / session store (Stacks ORM, SQLite) │
│   • checkpointing, VCS, terminals, fs, MCP passthrough       │
│   • approvals + project trust                                │
└──────────────────────┬───────────────────────────────────────┘
                       │ per-driver transport (see §7)
┌──────────────────────▼───────────────────────────────────────┐
│ Agent CLIs installed on the machine                          │
└──────────────────────────────────────────────────────────────┘
```

### Three principles borrowed deliberately

**1. The server is the execution boundary.** No client ever spawns a process, touches git, or reads
the filesystem. Every provider process, terminal, and fs read happens server-side. This is what makes
"drive it from your phone" fall out for free rather than being a feature, and it is the single
best structural idea in t3code.

**2. Commands in, events out, projections derive state.** Clients dispatch typed commands; a single
worker fiber processes them in total order; each becomes a persisted event; projections derive the
read model. A durable command receipt makes retries idempotent. This is what makes
checkpoint/revert, reconnect-mid-turn, and multi-client consistency tractable instead of a pile of
special cases.

**3. The driver is the only component that knows which agent it is.** Everything above it names a
*thread*, never an agent. Adding a provider is one driver file plus one registry entry — no
contract change, no orchestration change, no client change.

### Three things we do differently

**1. No Effect.** t3code's largest single source of build weight, onboarding cost and stack-trace
noise. We use Stacks' own Result type, Actions and DI. More importantly it is a dependency we do not
own, which violates the first-party rule.

**2. SSR-first with islands, not an SPA.** A session transcript is mostly-static append-heavy text —
the worst possible case for a component tree that re-reconciles, and the best possible case for
server rendering. stx already ships what this needs:
- `@stream('id') … @fallback … @endstream` (`stx/docs/features/streaming-ssr.md`) flushes the shell
  immediately and streams slow regions in as their data resolves. The session list paints before the
  git status query returns.
- `stx-hydrate="visible|idle|interaction|media:(…)"` (`stx/docs/features/lazy-hydration.md`) defers
  wiring interactive subtrees. Only the composer and the live tail of the transcript hydrate eagerly;
  scrolled-off turns hydrate on `visible`, and never at all if you don't scroll to them.

**3. Native shell, native chrome.** Craft gives us NSSplitViewController, Liquid Glass materials, a
real system tray, keychain-backed credential storage, and — after §10.1 — real trackpad gesture
phases. Electron gives t3code a `div`.

### Reconnect and replay

Stacks realtime already has the piece this needs:
`storage/framework/core/realtime/src/replay-buffer.ts` implements a per-channel ring buffer with
monotonic `seq` ids — a client sends its last-seen `seq` on reconnect and the server replays
everything after it. We configure it per-thread channel so a network blip mid-turn does not lose
assistant deltas. `ws.ts` exposes `setWsAuthenticator()` for the upgrade-time auth in §12.

---

## 4. Repo layout

`~/Code/harness` currently holds nothing but `.git`, and `buddy new` explicitly accepts a directory
containing only `.git` (`create.ts:isFolderCheck` — "creating the repository on GitHub first and
cloning it before scaffolding is the common way to start"). So we scaffold in place:

```bash
cd ~/Code/harness
eval "$(pantry env)"           # bun must be 1.3.14 — see §2
~/Code/stacks/buddy new harness --api --database --realtime --minimal
```

- `--minimal` runs `stripFeatures()` — skips cms/commerce/dashboard/marketing/monitoring/queue
  bundles. Any of them can come back later via `./buddy <feature>:install`.
- We do **not** pass `--with-core`, so `unvendorCore()` runs and harness resolves every `@stacksjs/*`
  from npm like a real user's app. This keeps us honest about the published surface — if something we
  need isn't exported, we fix it upstream instead of reaching into a vendored copy.

```
harness/
  app/
    Actions/Harness/       StartTurn · Interrupt · RespondApproval · RevertCheckpoint · SwitchProfile
    Models/                Profile · Workspace · Session · Turn · Event · Checkpoint · ProviderInstance · Approval
    Jobs/                  DriverSupervisor · CheckpointCapture · ProviderProbe
    Listeners/             the projections
    Commands/              harness CLI verbs
    Events.ts  Gates.ts  Routes.ts  Scheduler.ts
  config/
    harness.ts             drivers, budgets, telemetry
    ai.ts                  provider credentials (v1: passthrough only)
    realtime.ts            channels + replay-buffer config
  database/migrations/
  packages/
    contract/              command + event schemas, CBOR codec (client ⇄ server)
    drivers/
      claude/ codex/ cursor/ opencode/ grok/
      conformance/         the one spec every driver must pass
    client/                connection supervisor, session, state atoms
  resources/
    views/                 stx pages
    components/            harness-specific stx components
    layouts/
  tests/
  .github/
    scripts/check-lockfile-version.ts
    workflows/ci.yml release.yml
  deps.yml                 bun.sh: 1.3.14  (exact)
```

Everything under `packages/` is a Bun workspace inside harness. Nothing there is generic enough for
Stacks core *yet*; when a piece proves itself — the driver protocol is the likely first — it gets
**promoted upstream** to `storage/framework/core/`, not copied.

---

## 5. Data model

Stacks ORM (`defineModel()`), SQLite. Migrations generated via `./buddy make:migration`.

| Model | Key fields | Relationships |
|---|---|---|
| `Profile` | `name`, `icon`, `tint` (seed colour or full palette JSON), `order`, `settings`, `lastActiveWorkspaceId` | `hasMany(Workspace)`, `hasMany(ProviderInstance)` |
| `Workspace` | `path`, `name`, `vcsRoot`, `defaultBranch`, `trusted` | `belongsTo(Profile)`, `hasMany(Session)` |
| `Session` | `title`, `driverKind`, `providerSessionId`, `state`, `runtimeMode`, `interactionMode`, `lastSeq` | `belongsTo(Workspace)`, `hasMany(Turn)`, `hasMany(Checkpoint)` |
| `Turn` | `role`, `status`, `startedAt`, `endedAt`, `tokensIn/Out`, `cost` | `belongsTo(Session)`, `hasMany(Event)` |
| `Event` | `seq` (monotonic per session), `type`, `payload`, `commandId` | `belongsTo(Turn)` — **the append-only log; everything else is a projection** |
| `Checkpoint` | `kind` (`turn-start`/`turn-end`), `vcsRef`, `dirtyFilesSnapshot` | `belongsTo(Session)` |
| `ProviderInstance` | `driverKind`, `config`, `status`, `binaryPath`, `resolvedHome` | `belongsTo(Profile)` |
| `Approval` | `toolName`, `argsDigest`, `decision`, `scope` (`once`/`session`/`workspace`/`always`) | `belongsTo(Session)` |

Two deliberate choices:

- **`Event` is the source of truth.** `Session.state`, `Turn.status`, the transcript — all
  projections rebuilt from `Event`. Costs a little write amplification; buys checkpoint/revert,
  reconnect replay, multi-client consistency and a debuggable audit trail. Retrofitting this onto
  mutable state later is not realistic, which is why it is in M1 and not M6.
- **`ProviderInstance` belongs to a `Profile`, not globally.** Two profiles can hold two different
  Claude accounts with different `HOME`s, which is a thing t3code needed a whole docs page for and
  we get from the profile model.

---

## 6. The contract: commands and events

`packages/contract` is the only thing both sides import. CBOR-framed over Stacks realtime — JSON
deltas dominate the socket in a streaming agent UI, and CBOR is meaningfully cheaper to encode and
parse. pi's `packages/protocol/cbor` is the right instinct; we take the idea, not the code.

### Client-dispatchable commands

```
session.create            { workspaceId, driverKind, model?, providerInstanceId }
session.turn.start        { sessionId, text, attachments? }
session.turn.interrupt    { sessionId }
session.approval.respond  { sessionId, approvalId, decision, scope }
session.input.respond     { sessionId, requestId, value }
session.checkpoint.revert { sessionId, checkpointId }
session.stop              { sessionId }
session.mode.set          { sessionId, runtimeMode | interactionMode }
profile.create/update/reorder/delete
workspace.add/remove/trust
```

### Server-internal commands (never client-dispatchable)

```
thread.message.assistant.delta   thread.message.assistant.complete
thread.tool.call.begin/update/end
thread.approval.request          thread.input.request
thread.session.set               thread.error
```

Provider output arrives as internal commands, goes through the same queue, and becomes the same kind
of `Event`. One path, not two.

### Subscriptions

```
subscribeSession(sessionId, sinceSeq?)   → Event stream (replay-buffer backed)
subscribeProfile(profileId)              → session list + status projections
subscribeProviders()                     → driver availability/probe results
```

`sinceSeq` is what makes reconnect-mid-turn lossless.

### Buffered assistant delivery

Borrowed from t3code, because the reasoning is sound: a session in `buffered` mode accumulates
assistant text rather than pushing every delta. The buffer is **not** held to turn completion — it
spills at a character cap (t3code uses 24,000) and flushes at every interaction boundary (approval
opened, input requested). Without those two rules, buffering turns into "the UI freezes for 40
seconds then dumps a wall of text".

---

## 7. The driver layer

### Transports, per provider

Read out of t3code's `apps/server/src/provider/`, which is the most complete public map of how these
CLIs actually want to be driven:

| Driver | Transport | Notes |
|---|---|---|
| `claude` | Claude Agent SDK, managed server process | Secondary capability probe reads account + slash-command metadata; keyed by binary + resolved `HOME` so two instances don't cross-contaminate |
| `codex` | Codex **app-server**, JSON-RPC over stdio | Launch args matter (`codexLaunchArgs`); has its own developer-instructions injection |
| `cursor` | **ACP** (Agent Client Protocol, JSON-RPC) | plus a Cursor-specific extension layer |
| `grok` | **ACP** (`grok agent stdio`) | the official Grok Build CLI (xai-org, beta since 2026-05); the subcommand shape is Zed's registry entry, not `acp` |
| `opencode` | **ACP** (`opencode acp`, documented) | t3code's map said "own CLI/HTTP runtime, needs CLI output parsing" — stale by the time we got here; opencode 1.18 ships a native ACP server |

**Design consequence: ACP is the priority abstraction.** Three of five providers speak it today and
the direction of travel is toward more — opencode *became* one between this section being written
and M5 reaching it. `packages/drivers/src/acp.ts` is a real ACP client — JSON-RPC framing, session
lifecycle, tool-call and permission-request mapping — and Cursor, Grok and OpenCode are thin
extensions over it. Claude and Codex are bespoke.

### Driver interface

```ts
interface Driver {
  kind: DriverKind
  configSchema: Schema
  probe(): Promise<ProviderSnapshot>          // installed? authed? version? capabilities?
  create(config): Promise<ProviderInstance>   // owns a child process scope
}

interface ProviderInstance {
  startSession(workspace): Promise<ProviderSessionId>
  startTurn(input): AsyncIterable<ProviderEvent>
  interrupt(): Promise<void>
  respondApproval(id, decision): Promise<void>
  stop(): Promise<void>
}
```

`ProviderEvent` is the narrow union every driver normalises into. Everything above the driver sees
only this.

### Three server-side workers

Queue-backed, each exposing `drain()` for deterministic test synchronisation (t3code's
`makeDrainableWorker` pattern — the single best testability decision in that codebase):

1. **Ingestion** — consumes provider streams, emits internal commands.
2. **Command reactor** — reacts to intent events, dispatches provider calls.
3. **Checkpoint reactor** — captures on turn start/end, performs reverts.

### Conformance suite

`packages/drivers/conformance` is one spec every driver must pass, run against the real CLIs in a
nightly CI job:

- start a session in a temp workspace; assert a `ProviderSessionId`
- run a turn that produces text; assert ordered deltas then exactly one completion
- run a turn that calls a tool; assert `begin → update* → end` ordering
- run a turn requiring approval; assert the request surfaces and the decision is honoured
- interrupt mid-turn; assert the stream terminates and no events arrive after
- kill the child process mid-turn; assert a clean `thread.error`, no orphan, no hang
- restart the server mid-turn; assert session recovery or a clean failed state
- probe with the binary absent; assert an `unavailable` snapshot, not a crash

This is what turns "add a provider" from a project into a weekend.

---

## 8. Surfaces

### Shared

`resources/views/**` is written once. `packages/client` holds every non-visual client concern —
connection supervisor with backoff, the session, cached environment data, state atoms. Views never
construct a transport. Web and desktop differ only in the platform layer they supply; this is the one
piece of t3code's client architecture worth copying wholesale.

### Web (M3)

Stacks server renders stx. Page structure:

| Region | Rendering | Hydration |
|---|---|---|
| Profile sidebar | SSR | eager (gestures + keyboard) |
| Session list | SSR, `@stream` for git status | `visible` |
| Transcript, scrolled-off turns | SSR | `visible` |
| Transcript, live tail | SSR shell + WS deltas | eager |
| Composer | SSR | eager |
| Approval prompt | SSR | eager |
| Diff view | SSR | `interaction` |

Long transcripts use stx's `ui/virtual-list`. The transcript must never grow the DOM without bound —
that is the specific thing that makes every Electron agent UI feel bad at 10k lines.

### Desktop (M4)

Craft window over the same server. `@stacksjs/desktop` (from stx) wraps Craft and already exposes
keychain, system tray, global shortcuts, notifications, deep links, theme and window events. Native
chrome:

- titlebar/toolbar tint follows the active profile (needs §10.2)
- native spaces sidebar mirroring the web one (needs §10.2)
- system tray with running-session count
- global shortcut to summon the window
- Craft's updater for auto-update

### CLI (M2)

`./harness` is a thin client of the server, not a second runtime. A session started in the terminal
is visible in the desktop app and on the phone, because there is only ever one execution boundary.
This is a deliberate divergence from pi, whose TUI owns an in-process agent and therefore cannot do
this.

---

## 9. Profiles and the Arc sidebar

**A profile is a workspace/project.** Its own repos, sessions, agents, MCP servers, env and
credentials. Swiping switches which project you are working in.

stx already ships the whole web-side implementation — `<Sidebar :spaces>` swaps its scrollable list
for a swipe track and defaults `theme` to `arc` (`stx/docs/features/sidebar-spaces.md`). Our
integration is a data mapping, not new UI:

```ts
const spaces = profiles.map(p => ({
  id: p.id,
  label: p.name,                    // "Personal", "Stacks", "Work"
  icon: p.icon,
  tint: p.tint,                     // seed colour, or a full light/dark palette
  pinned: p.repos,                  // favourite repos — the tile grid in the screenshot
  sections: [
    { id: 'active', header: 'Active', items: p.runningSessions },
    { id: 'recent', header: 'Recent', items: p.recentSessions },
  ],
  clear:  { label: 'Clear' },
  action: { label: 'New Session' },
}))
```

```html
<Sidebar :spaces="spaces" :space="activeProfile" spacePersistKey="harness.profile" showSpaceAdd
         @spaceChange="onProfileChange($event)"
         @spaceAdd="createProfile()"
         @spaceAction="startSession($event)" />
```

`spacePersistKey` handles client-side restore; the server persists `Profile.lastActiveWorkspace` so a
phone and a desktop agree on where you left off.

### What "works properly" means — acceptance criteria

| # | Criterion |
|---|---|
| 1 | Two-finger trackpad swipe tracks at 1:1 and settles like a `UIScrollView` — in a Craft window (via §10.1) **and** in a plain browser (via the existing wheel heuristic) |
| 2 | When both paths are live, the native stream supersedes the heuristic and the swipe settles **once** — `cancelWheelGesture()` fires on native `begin` |
| 3 | Touch/pen drag has an 8px axis lock; a **mouse** drag does nothing (it is far more likely a text selection) |
| 4 | Release commits past ⅓ of a panel, or on a flick in the direction of travel; otherwise snaps back |
| 5 | Past the first/last profile the track still answers the finger but compresses toward an asymptote |
| 6 | Each profile keeps its own scroll position and disclosure state across switches |
| 7 | The whole pane — rows, headers, counts, search, footer — **and the native titlebar** — crossfades to the new tint, in a perceptually even space |
| 8 | `prefers-reduced-motion: reduce` switches instantly: no settle animation, no crossfade |
| 9 | Off-screen profiles are `inert`; Tab never walks through rows you cannot see |
| 10 | ⌘⌥←/→ works window-wide; bare ←/→ only while a rail button has focus |
| 11 | `spaceChange.source` is correct for each of `swipe`/`switcher`/`keyboard`/`native`/`restore`/`api` |
| 12 | A seed colour and an equivalent full palette produce identical custom-property surfaces |
| 13 | All of §10.4's tests green |

Criteria 1–12 are all behaviours stx already claims. **None of them are currently tested** — see
§10.4. That is the actual risk here, not the feature.

---

## 10. Upstream fixes — at the source

Prerequisites, not nice-to-haves. Each is a real gap found by reading the code; each is fixed in its
own repo and shipped with `bun run release:patch`.

### 10.1 Craft — `window.craft.gestures` does not exist

`stx/packages/components/src/ui/sidebar/SidebarSpaces.stx:373` feature-detects
`window.craft?.gestures?.onSwipe` and falls back to a `wheel`-event heuristic. The fallback works.
The native path it defers to was never built:

- `craft/packages/zig/src/js/` ships `craft-app.js`, `craft-bridge.js`, `craft-native-ui.js`,
  `craft-tray.js`, `craft-window.js`. **There is no `craft-gestures.js`.**
- `craft/packages/typescript/src/` has no `gestures` module — the only hits for the word are in a
  mobile e2e test.
- `craft/packages/zig/src/gesture.zig` recognises swipes from **touch points only**. Nothing forwards
  macOS `NSEvent` scroll-wheel phases. (The two `NSEvent` TODOs in `macos.zig:3583` and `:5179` are
  about global hotkeys, not scroll — but they confirm there is no NSEvent monitoring infrastructure
  to build on yet.)

**Why this is a latency bug, not polish.** The web fallback ends a gesture on a 90ms idle gap
(`SidebarSpaces.stx:246`). macOS momentum scrolling keeps emitting `wheel` events with sub-90ms gaps
for up to ~1.5s after the fingers lift. So on a trackpad the swipe settles at *the end of momentum*,
not at finger-up — a visible ~1s lag on every swipe that no amount of tuning in JS can fix, because
the phase information simply is not in the DOM event. This is the whole argument for §10.1.

**Fix:**

1. **Zig — capture the event via a local monitor, not a subclass.** All three WKWebView creation
   sites (`macos.zig:747`, `:2088`, `:3075`) use `getClass("WKWebView")` directly — there is no
   `CraftWebView` subclass, and adding one would not reliably help, since WKWebView's internal
   scroll view consumes `scrollWheel:` before a subclass override sees it in the useful cases. Use
   `NSEvent.addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel` instead — the API the
   codebase already names as the intended approach at `macos.zig:5179`. Read `phase`,
   `momentumPhase`, `scrollingDeltaX/Y`, `hasPreciseScrollingDeltas`; derive `velocityX` from the
   momentum stream. Return the event unmodified — vertical scrolling must still reach the page.
2. **Injected JS.** New `packages/zig/src/js/craft-gestures.js` installing `window.craft.gestures`
   with `onSwipe(cb) → off`, emitting exactly the shape `SidebarSpaces.stx:377-404` already consumes:
   `{ axis, phase: 'begin'|'change'|'end', deltaX, deltaY, velocityX, momentum }`. Sign convention
   must match the wheel path: **positive `deltaX` advances to the next space**
   (`SidebarSpaces.stx:242` does `wheelOffset += event.deltaX / width`).
3. **Register it in all five places.** See §10.8 — craft has *two* injection mechanisms across
   *three* window-creation paths. Missing one is how you get "gestures work in the main window but
   not the one with the sidebar", which is the exact window harness ships.
4. **SDK.** `packages/typescript/src/api/gestures.ts` + export from `api/index.ts`.
5. **Parity.** Bridge iOS `UIPanGestureRecognizer` and Android `MotionEvent` to the *same* event
   shape. One contract, three hosts.
6. **Tests.** `packages/typescript/src/__tests__/gestures.test.ts` for the SDK surface; a Zig unit
   test for phase→event mapping including the momentum tail.

### 10.2 Craft — `nativeUI.createSpacesSidebar` does not exist

`SidebarSpaces.stx:410` calls `window.craft.nativeUI.createSpacesSidebar()`. The injected
`craft-native-ui.js:26-29` defines only `createSidebar`, `createFileBrowser`, `createSplitView`
(with `window.craft.components` aliased to `nativeUI` at `:35`).

**Fix:**

1. `packages/zig/src/components/native_sidebar.zig` + `bridge_native_ui.zig` — add a spaces variant
   carrying a space list, an active space, and a native switcher (NSSegmentedControl in the toolbar
   on macOS; the rail elsewhere). `bridge_native_ui.zig:240` currently warns and bails if a sidebar
   already exists — the spaces variant must be the *same* sidebar in a different mode, not a second
   one.
2. `craft-native-ui.js` — add `createSpacesSidebar({ id, spaces, activeSpace })` returning a handle
   with `onSpaceChange(cb)`, `setSpaces()`, `setActiveSpace()`, `destroy()`.
3. `packages/typescript/src/components/sidebar.ts` — `SidebarStyle` already includes `'arc'` (`:103`)
   and `arcStyle` already exists (`:261`), but neither knows about spaces. Extend `SidebarConfig`
   with `spaces` and wire the events.
4. Per-space tint must reach native chrome so titlebar and toolbar crossfade with the pane
   (acceptance criterion 7).

### 10.3 Craft — two conflicting `SidebarItem` types

`api/sidebar.ts:14` and `components/sidebar.ts:31` both export `SidebarItem` with different shapes.
`components/sidebar.ts`'s own doc comment warns: the top-level package exports the `api` version, so
importing from `craft-native/components` silently gets you the other one. That is a latent bug for
anyone doing exactly what harness will do.

**Fix:** one `SidebarItem` in a shared types module, both re-export it, deprecation shim for a
release.

### 10.4 stx — four real bugs in `SidebarSpaces`, and zero test coverage

Having now read all 560 lines, here are the constants the test suite must assert against, and four
defects found by reading.

**The constants** (`SidebarSpaces.stx:75-84`), all in *panel* units so they're independent of pane
width:

| Constant | Value | Meaning |
|---|---|---|
| `SETTLE_MS` | `420` | settle animation, matched by the tint transition in `Sidebar.stx:642` |
| `SETTLE_EASE` | `cubic-bezier(0.22, 0.61, 0.36, 1)` | |
| `RUBBER_LIMIT` | `0.28` | past-the-end asymptote |
| `COMMIT_DISTANCE` | `0.3` | drag distance that commits |
| `COMMIT_VELOCITY` | `0.0015` | panels/ms — 1.5 panels/sec |
| wheel idle | `90ms` | `:246` |
| axis lock | `8px` | `:295` |

Note the docs say "a third of a panel" but the code is `0.3`, not `1/3`. Harmless, but the test
should encode the code's number and the doc should match it.

**Bug A — standalone `<SidebarSpaces>` renders untinted.** The `@property` registrations, the
gradient `background`, and the 420ms tint transition all live in **`Sidebar.stx:617-657`**.
`SidebarSpaces.stx`'s own `<style scoped>` (`:525-559`) has only viewport and track rules.
`applyTint()` (`:126`) writes `--stx-space-light-*` / `--stx-space-dark-*` onto
`root.closest('[data-stx-sidebar]') || root` — and the docs explicitly advertise standalone use
("falling back to its own root when used standalone"). But standalone there is no `Sidebar.stx` in
the tree, so nothing registers, consumes or transitions those variables. The documented fallback
produces a pane with no gradient and no crossfade. Fix: move the `@property` block and the base
gradient into `SidebarSpaces.stx`, or into a shared stylesheet both import.

**Bug B — `inert` is client-only, so SSR ships every space in the tab order.** `markCurrent()`
(`:150-157`) sets `panel.inert = !current`, but it only runs in `onMount`. The server-rendered HTML
carries no `inert`, so between first paint and hydration Tab walks through every row of every
space — the exact failure the comment at `:153-155` says it is preventing, just in the window before
hydration. Given we are betting on SSR (§8), this window is not theoretical. Fix: emit `inert` from
`SidebarSpace.stx` for non-active spaces server-side.

**Bug C — the native/wheel handoff snaps the track.** `cancelWheelGesture()` (`:257-260`) clears the
idle timer and nulls `wheelOffset`, but does **not** reset the painted transform. `bindCraftGestures`
then calls `beginGesture()` (`:387`), which sets `gestureStart = index()` — while the track is still
painted at the wheel gesture's drifted offset. The first native `change` paints from `index()`, so
the track visibly jumps backwards at the moment the native stream takes over. This seam only exists
once §10.1 lands, which is precisely why it must be tested alongside it.

**Bug D — `⌘⌥←/→` is global and unscoped.** `onShortcut` (`:344`) is bound to `window` (`:457`) with
no check that this sidebar is the active one. Two `<Sidebar :spaces>` instances on a page both
advance. Minor, but a one-line fix.

**Also worth confirming, not clearly a bug:** `settle()` (`:206-213`) commits to
`gestureStart + direction` where `direction` is `±1`, so a swipe can never advance more than one
space no matter how far or fast it is dragged. Arc behaves this way too, so this is probably
intentional — but it should be a documented decision with a test pinning it, not an accident.

#### Test coverage

`packages/components/test/` currently contains `sidebar-route-selection.test.ts` and
`sidebar-header.test.ts` — **5 tests, all passing.** `SidebarSpaces.stx` has none. It is the
highest-risk file in the stack for us, and harness's flagship feature sits directly on it.

`packages/components/test/` contains `sidebar-route-selection.test.ts` and `sidebar-header.test.ts` —
**5 tests total, all passing.** `SidebarSpaces.stx` is 560 lines of gesture mathematics (resistance
curve, settle thresholds, flick detection, axis lock, `inert` management, palette crossfade,
persistence) with **no tests at all**. It is the highest-risk file in the entire stack for us, and
harness's flagship feature sits directly on top of it.

**Fix — `packages/components/test/sidebar-spaces.test.ts`**, one test per acceptance criterion in §9:

- wheel-gesture claim: horizontal-first claims, vertical-first never claims, idle gap ends it
- touch/pen 8px axis lock; mouse drag is a documented no-op (trivially easy to regress)
- settle: commits past ⅓; commits on sub-⅓ flick; snaps back otherwise
- rubber-band asymptote past first/last
- `inert` on off-screen spaces; Tab never reaches them
- `spacePersistKey` round-trip through localStorage
- `prefers-reduced-motion` drops animation but still switches
- `spaceChange.source` correct for all six sources
- palette: seed vs full palette produce identical custom properties
- **Craft path:** fake `window.craft.gestures`, assert it supersedes the wheel heuristic and that
  `cancelWheelGesture()` prevents a double settle

### 10.5 stx — docs promise what Craft cannot yet do

`docs/features/sidebar-spaces.md` §Native documents both Craft integrations as working. Once §10.1
and §10.2 land the docs become true, so the fix is ordering: land Craft first, and no doc change is
needed.

### 10.6 Stacks — desktop launcher hardcodes a personal path

`storage/framework/core/desktop/src/index.ts:75` resolves the Craft binary from
`join(homedir(), 'Code/Tools/craft')` before falling back to a bare `'craft'`. Works on this machine
and nowhere else.

**Fix:** resolve in order — `config/desktop.ts` → `CRAFT_BIN` env → `node_modules/.bin/craft` →
`$PATH` → the dev-checkout guess; error with install instructions if none hit.

### 10.7 stx / craft / stacks — Bun ranges do not actually pin

Per §2: `^1.3.14` admits 1.4.0, and `craft/pantry.jsonc` says `"bun.sh": "latest"` outright. On this
machine the ambient `bun` is already 1.4.0, so a stray `bun install` in either repo silently rewrites
`bun.lock` to `lockfileVersion: 2` and breaks their CI.

**Fix:**
- `craft/pantry.jsonc`: `"bun.sh": "latest"` → `"1.3.14"`
- `craft/deps.yaml`, `stx/deps.yaml`, `stacks/deps.yml`: `^1.3.14` → `1.3.14`
- port the `check-lockfile-version.ts` guard into stx and craft CI (Stacks already has it)
- add a `bun --version` assertion to each repo's CI preflight

This is small, and it prevents the exact class of breakage that costs an afternoon of confused
bisecting.

### 10.8 Craft — two JS injection mechanisms across three window paths

Found while tracing where `craft-gestures.js` would have to be registered. Craft injects its JS two
different ways depending on which window-creation function you call:

| Path | Function | Mechanism | Scripts |
|---|---|---|---|
| plain window | `macos.zig:~540` | `addUserScript:` at `:710`, `:715`, `:725` | bridge, sidebar bootstrap, native-ui |
| window + native sidebar | `createWindowWithSidebar` (`:~1866`) | **HTML string splice** at `:2100-2126` | bridge, sidebar bootstrap, native-ui |
| window + sidebar, from URL | `createWindowWithSidebarURL` (`:~2925`) | `addUserScript:` at `:3059`, `:3065`, `:3071` | bridge, native-ui, flag script |

Two consequences:

1. **Adding one script means five edits.** Miss one and `window.craft.gestures` is silently absent
   in that window type. Harness's desktop window is "a window with a native sidebar" — the middle
   row, the odd one out.
2. **The spliced path is fragile across navigation.** Scripts spliced into `<head>` belong to that
   one document. `addUserScript:` with `AtDocumentStart` re-injects on every navigation.
   So in a `createWindowWithSidebar` window, a reload or a real navigation loses `window.craft`
   entirely. For an SSR-first app that navigates between server-rendered pages (§8), that is a
   direct hit.

**Fix:** one `injectCraftScripts(userContentController)` helper used by all three paths, all via
`addUserScript:` with `WKUserScriptInjectionTimeAtDocumentStart`. Delete the splicing path. Then
`craft-gestures.js` is one edit, and navigation stops being a special case.

---

### 10.9 Framework bugs found while building M1

Three, all hit within an hour of scaffolding, all fixed upstream in Stacks.

**`--minimal` did not strip commerce.** Not a missing gate — the gate exists and works. `stripFeatures`
ran *after* `install()`, which shells out to `./buddy migrate` and `./buddy seed`, so the config flip
landed on a database that had already materialised and seeded every feature. A `--minimal` project
came out claiming commerce was off with `orders`, `carts` and thirty-odd tables fully populated.
Fixed by stripping before install.

**A migrate failure recommended a command that could not help.** Any failure advised
`./buddy migrate:fresh`; for a constraint violation that is the one thing that cannot work — it drops
the database, replays the same DDL against the same rows, and fails identically. The only exit was
deleting the SQLite file by hand.

Worth recording, because the error itself misleads: `UNIQUE constraint failed: index 'x'` is **not**
what a plain `CREATE UNIQUE INDEX` over duplicates produces. Verified against `bun:sqlite` —
create-over-duplicates and duplicate-INSERT both report `table.column`. SQLite only names the *index*
for an expression index or a 12-step table rebuild, so the conflict arises while rows are being
copied. That note is now in the diagnostic.

**The FK auditor claimed keys the generator would never emit.** The auditor inferred a foreign key
from any `_id` column whose stem matched a model. bun-query-builder does not: its `declaresBelongsTo`
rule applies convention only to models that declare no `belongsTo`, because once a model documents
its relations, a `_id` column outside that list is a column that happens to end in `_id` — guessing
anyway constrains against the wrong table. So every migrate warned about phantom foreign keys and
then recommended a destructive command to reconcile a non-defect. The generator was right; the
auditor now mirrors its rule.

**Also worth knowing:** an app command does not override a framework command. Naming ours `serve`
silently started the Stacks production server; it is `harness:serve`.

### 10.10 Craft — every window action that takes an argument was broken

Found by reading `--timing` output, not by looking for it: `setWebSidebarCollapsed: MISSING_DATA`
appeared in the log of every single launch, and had done since M4.

The bridge's message router extracts the payload correctly, then calls `handleMessage(action)` — the
overload that exists for actions taking *no* data. So `setSize`, `setTitle`, `setPosition`,
`setFullscreen`, `setOpacity`, `setWebSidebarCollapsed` and 13 more received null and answered
MISSING_DATA no matter what the page sent. The app bridge had the same shape: `notify` and `setBadge`
could never see their arguments. Both now route through `handleMessageWithData`, which already existed.
Fixed with regression tests, released as **craft v0.0.62**.

### 10.11 Craft — `zig build test` could not compile, so nothing ran it

`std.crypto.random.bytes` is gone in the pinned Zig and is referenced from keychain, crypto, api_crypto
and hotreload, so any test build reaching them died at compile time and took the whole suite with it.
This was logged as a known blocker in M4 and left alone; it turns out to be the reason craft had no
enforced test signal at all.

`compat.randomBytes` follows the module's existing pattern for std gaps and goes to the platform CSPRNG
— `arc4random_buf` on Apple/BSD/Linux, `RtlGenRandom` on Windows, its result checked rather than assumed,
since silently zeroed "random" bytes is the worst possible failure for a key. Seeding a userspace PRNG
from a clock would have compiled just as well and been wrong. **98/98 steps now pass.**

The same class of break, one dependency further out: **zig-gc** compared `builtin.mode == .Debug`, the
pre-rename capitalisation, in a branch only instantiated under test — so `zig build` was fine and
`zig build test` could not compile. Fixed by comparing on the tag name, which works either side of the
rename, matching the idiom zig-js already uses. 58/58 pass.

### 10.12 Craft — `--timing`, and what it found

`--benchmark` prints `ready` at window creation and exits, so the expensive part — WebKit coming up and
the page arriving — was invisible to it. `--timing` records named marks against one monotonic clock and
prints the gaps; it is a fixed-size array of integers on a path already doing Objective-C message sends,
so it stays compiled in and prints nothing unless asked.

It immediately showed 58ms between having a webview and telling it to load, spent on translucency, the
file-drop hook and the UI delegate — none of which the network was waiting for. The load now goes first.
**Honest result: end-to-end cold start did not measurably improve**, because WKWebView launches its
WebContent process at *creation*, not at `loadRequest:`, so firing the load earlier shifts a wait rather
than removing one. The ordering is still right, and the measurement is the durable part.

### 10.13 zig-js — where it fits, and where it does not

Craft does **not** use zig-js today; it has zero dependencies and drives WKWebView directly.

It cannot replace the page's JavaScript. That runs in WebKit's own JSC inside the WebContent process,
which craft does not control, so zig-js does nothing for the cold-start numbers above.

Where it does fit is craft's *own* injected sources. Craft splices six JS files into every webview and
none of them had a test — the only way to exercise `window.craft.gestures` was to launch an app and
swipe a trackpad, which is how the gesture registry shipped. zig-js runs them headlessly: no WebKit, no
window, no WebContent process, 627ms for the file. Wired as **opt-in** (`-Djs-tests`) with a lazy
dependency, because it needs the sibling checkout that an npm consumer will not have; without the flag
nothing changes. Released as **craft v0.0.63**.

The next use, not yet built: craft can only evaluate JS today by having a WKWebView, so a tray-only app
or a background task pays a whole WebContent process to run a callback. `craft.evalHeadless` over zig-js
would make that free.

## 11. Performance budgets

Enforced in CI. stx already has `scripts/performance-budgets.ts`; mirror the approach.

| Metric | t3code (Electron) | harness budget |
|---|---|---|
| Desktop cold start → interactive | ~1–2s | **< 300ms** |
| Desktop installed size | ~150MB | **< 15MB** |
| Idle RSS, one session open | ~250MB | **< 60MB** |
| Session-list first paint, 500 sessions | — | **< 50ms** (SSR shell) |
| Transcript append, 10k-line session | **1.6ms median, 2.0ms p95** (9,568 lines, 506 turns) | **< 4ms** frame budget |
| Profile swipe | — | **120Hz, zero dropped frames** |
| Server memory, 20 concurrent sessions | — | **< 300MB** |
| Reconnect → caught up, 30s of missed deltas | — | **< 200ms** |

The levers, in descending order of impact:

1. **Craft instead of Electron.** The single biggest win, and it is already built.
2. **SSR + islands instead of an SPA.** §8's hydration table is the mechanism.
3. **Virtualised transcript.** stx ships `ui/virtual-list` and `ui/virtual-table`; use them rather
   than growing the DOM.
4. **Spaces pre-rendered side by side**, so a profile switch is a `transform` not a re-render. This
   is already how `SidebarSpaces` works — the job is not to fight it.
5. **CBOR frames**, not JSON, for the delta-dominated socket.
6. **Bun everywhere.** No Node startup tax on server or CLI.
7. **`@stream` boundaries** for git status, provider probes and anything else that would otherwise
   hold the first paint hostage.

---

## 12. Security model

Not deferred. An agent harness is a remote-code-execution surface by construction, and retrofitting
this is how projects get CVEs.

**Project trust.** A workspace is untrusted until explicitly trusted (pi's `project-trust.ts` is the
right shape). Untrusted workspaces do not load project-level config, do not install packages, do not
run project extensions. Trust is per-workspace, persisted, and revocable.

**Tool-call approvals.** Every provider approval request becomes an `Approval` row and an event, with
scope `once` / `session` / `workspace` / `always`. Decisions are auditable after the fact — "what did
I approve and when" is a question you will want answered.

**Credential storage.** `@stacksjs/desktop`'s `keychain.ts` wraps macOS/iOS Keychain, Windows
Credential Manager and Linux Secret Service, and deliberately has **no web fallback** — it throws
outside a Craft window rather than silently downgrading to `localStorage`. That is the correct
behaviour and we rely on it. Provider credentials never touch our database.

**Transport auth.** `realtime/src/ws.ts` exposes `setWsAuthenticator()` for upgrade-time
authentication. Authorisation is **per command**, not per socket — holding a valid socket is not
permission to dispatch everything on it. This matters the moment remote-from-phone (M6) exists.

**Remote access.** Off by default. When enabled: TLS, device pairing, and a scoped token per device.

**Sandboxing.** v1 runs providers with the user's own permissions, like every other harness. The
`ProviderInstance` boundary is where a sandbox slots in later (Craft process isolation + Stacks'
shell layer), and it is drawn now so that stays possible.

---

## 13. Testing strategy

| Layer | Approach |
|---|---|
| Engine | Command → event → projection, in-memory SQLite. Determinism via `drain()` on each worker. |
| Contract | Round-trip every command and event through the CBOR codec; schema-compatibility test against the previous release. |
| Drivers | The conformance suite (§7) against fakes in PR CI, against real CLIs nightly (`conformance.yml`: `harness:doctor --conformance`, with opencode installed — the one provider that runs a real turn without secrets; the rest decline cleanly until CLIs/credentials are added). |
| Views | stx component tests, following the existing `packages/components/test/` pattern. |
| Sidebar | §10.4's suite lives upstream in stx, where the code is. harness adds only the data-mapping test. |
| Perf | Budgets from §11 as CI assertions, not aspirations. |
| Smoke | Desktop app boots, opens a window, connects, starts a session, exits clean. |

Non-negotiable: **a driver bug must be reproducible without the real CLI installed.** Every driver
ships a recorded-transcript fake.

---

## 14. CI and release

**CI** follows the Stacks pattern: pantry action (pinned by SHA) → cached `node_modules` →
`bun install --frozen-lockfile` → **lockfile-version guard** → lint (pickier) → typecheck → test →
perf budgets.

Ordering note carried over from Stacks' own CI comment: the bunfig preload resolves `@stacksjs/env`,
so anything invoking `bun` before `node_modules` exists dies with `preload not found`. Install first,
then guard, then everything else.

Preflight assertion at the top of every job:

```bash
bun --version | grep -qx '1.3.14' || { echo "Expected Bun 1.3.14 — see PLAN.md §2"; exit 1; }
```

**Release:** `bun run release:patch` publishes through GitHub Actions. Same in every upstream repo we
touch (stx, craft, stacks).

**Dependencies:** buddy-bot, not renovate. Bun itself is excluded from automated bumps until §2's
policy says otherwise.

---

## 15. Milestones

Each ends with something runnable.

### M0 — Upstream unblock *(no harness code)*

| # | Item | Status |
|---|---|---|
| §10.7 | Pin the toolchain (Bun 1.3.14, Zig dev.1509) | ✅ shipped |
| §10.8 | Unify Craft's script injection into one `addUserScript:` path | ✅ `craft@dd27334` |
| §10.1 | `window.craft.gestures` via `NSEvent` local monitor | ✅ `craft@v0.0.59` |
| §10.3 | Unify the duplicate `SidebarItem` | ✅ `craft@0c57dcd` |
| §10.4 | stx: bugs A–D + test suite | ✅ `stx@a7f20de` |
| §10.6 | Stacks desktop launcher path resolution | ✅ `stacks@679fe12` |
| §10.2 | `nativeUI.createSpacesSidebar` | ✅ `craft@v0.0.60` |

Released: `craft@v0.0.60`, `stx@v0.2.156`. **M0 complete.**

§10.2 landed as a native *switcher* rather than a native sidebar, which is what
`stx/docs/features/sidebar-spaces.md` describes: the spaces, rows and swipe stay in the webview and
only the chrome control is native. That also sidesteps `createSidebar`'s one-sidebar-per-window
restriction entirely, so a window can have both.

§10.8 deliberately went before §10.1: it turned adding the gesture script from five edits into
one, and fixed navigation dropping `window.craft` in the sidebar window type harness ships.

`release:patch` each.

**Exit:** a scratch stx page with `<Sidebar :spaces>` in a Craft window swipes on real trackpad
NSEvents, settles at finger-up rather than end-of-momentum, does not jump at the native handoff, and
survives a page navigation; stx's spaces suite green; `bun --version` is 1.3.14 in all four repos.

### M1 — Skeleton ✅ complete

| Piece | Status |
|---|---|
| Data model — 9 models, migrated | ✅ |
| `@harness/contract` — commands, events, CBOR codec | ✅ 20 tests |
| `@harness/engine` — ordered queue, receipts, projections | ✅ 18 tests |
| `@harness/server` — `harness:serve`, HTTP + CBOR websocket | ✅ 18 tests |
| `@harness/client` — supervisor, backoff, resume-from-cursor | ✅ 14 tests |

**70 tests.** Exit criterion met: `./buddy profiles:create` writes through the engine and
`profiles:list` rebuilds from the log in a cold process; a server restart with a second client
writing into the gap resumes losslessly.

Two bugs the tests could not have found, both surfaced by exercising the real thing:
- prompt and response were accumulating into one string (a turn is an *exchange*)
- `at` derived from second-resolution `created_at`, so one event had two timestamps depending on
  whether you were connected when it happened

Framework bugs fixed upstream along the way — see [§10.9](#109-framework-bugs-found-while-building-m1).

### M1 — Skeleton *(original scope)*
`buddy new` in place. Models + migrations (§5). The event-sourced engine: ordered command queue,
durable receipts, projections. Contract package with CBOR codec. `harness serve` boots.
**Exit:** `harness profiles:create` writes a profile; a projection reads it back; the engine replays
its log to identical state.

### M2 — One driver end to end
`packages/drivers/claude` over the Claude Agent SDK. Session create → turn start → deltas →
interrupt → approval. Realtime subscription per session with replay-buffer. `harness` CLI as a thin
client.
**Exit:** `harness run "list the files"` streams a real Claude Code turn; killing the server
mid-turn and restarting resumes without losing events.

### M3 — Web surface *(complete)*

The views, the sidebar and the transcript shipped in M3. The **live** half did not work in a browser
until the M4/M5 pass, and nothing caught it because the page renders correctly either way — the server
sends a complete transcript, so a dead socket looks exactly like a quiet session. It took opening the
page in a real browser; reading the template would not have found any of it.

Four bugs, each hidden by the one above it:

1. The island read `document.currentScript`, which is **always null inside a module**, per spec. It threw
   on its first line, so the socket was never opened.
2. With that fixed, `data-session="{{ activeSessionId }}"` arrived as literal mustache text — stx did not
   interpolate script-tag attributes, which for a module island is the only channel for server data.
   Fixed upstream (§10) and released as stx 0.2.161.
3. With data flowing, the island called `window.__harnessEncode` — a global nothing defined. The page
   speaks CBOR and had no codec. `@harness/contract` is pure, so it now bundles to a 3.3KB browser
   module the island imports: the same implementation the server uses, not a second one.
4. The subscribe frame sent `sinceSeq: window.__harnessSinceSeq ?? 0` — another global with one reader
   and no writer. Every load resubscribed from zero, the server replayed the whole session on top of the
   already-rendered transcript, and every response appeared twice. The projection had tracked `lastSeq`
   all along.

And one the fixes exposed: the island knew only the single live-response node present at page load, so a
turn started afterwards appended its reply to the *previous* turn's answer. It now opens a turn on
`turn.started`.

**Verified live in a browser:** three turns, each with its own prompt and answer, exactly one marked
live, no duplication, and text arriving over the socket with no reload.

The lesson is worth keeping: a server-rendered surface hides a broken client. Every island needs a
browser check, not a template review.

The composer and the approval buttons were rendered but unwired — the page could watch a session and not
drive one, which is most of the point of a control surface. Both dispatch over the same socket now, with
a deduplicable command id so a retry after a dropped ack replays the receipt rather than starting a
second agent run. Enter sends, Shift+Enter newlines.

**Exit criterion met, verified in a browser end to end:**

| Step | Result |
|---|---|
| Prompt typed into the composer | dispatched; textarea cleared, turn appears only on `turn.started` from the log |
| Agent replied | streamed in as deltas, new turn article, state → idle |
| Tool call raised an approval | panel showed `Read`, with the approval id |
| **Allow** clicked | tool ran; `note.txt`'s contents came back in the reply |
| **Deny** clicked on a `Write` | file never created on disk; agent reported the denial; session returned to idle, not wedged |

Session-list click-through already worked: the sidebar renders real `<a href="/s/:id">` links, and
navigating rebinds the island to the new session (verified — clicking a sidebar entry moved the URL, the
island's `data-session`, and the header together).

**The 10k-line transcript budget from §11 holds**, which is what settles the SSR-first risk in §16.
Measured in a browser against a real page carrying 506 turn nodes / 9,568 lines, appending exactly as the
socket does — `textContent +=` plus the scroll-follow that forces layout, since timing the append alone
would flatter it:

| | ms |
|---|---|
| median | 1.6 |
| p95 | 2.0 |
| p99 | 8.3 |
| max | 9.9 |

Under the 4ms frame budget at p95. The p99 spikes past it on occasional layout/GC, so a transcript that
grows without bound is still worth watching — but the architecture is not the problem, and mobile (M7)
can safely commit to the same views.

### Tool calls were logged and never shown

The transcript rendered the agent's reply and nothing else. `tool.call.began` /
`tool.call.ended` had been in the log since M2, the runtime emitted both, and the **projection dropped
them** — so an agent harness showed you the answer but not the six commands behind it, which is the part
you actually review.

Nothing was lost, which is the point of keeping a log: projecting them retroactively made every session
ever recorded show its tools on the next render, including the `Write` denied during the approval test.

Three states, not two: running, succeeded, failed. Collapsing that to a boolean makes a hung command read
as a completed one. Verified live in a browser — a `Read:running` row appeared 5.4s into a turn and
resolved to `Read:ok, Bash:ok` a second later, so the pending state is visible in flight rather than only
in hindsight.

Two defects fell out of building it. A hand-written `TurnState` fixture in the view tests drifted the
moment the type gained a field, and failed as a crash inside `viewProps` rather than as a message about
the fixture — it now goes through one builder. And `serve()` never forwarded its `workspacePath` option
to the runtime, so the option existed and did nothing.

### A missing workspace now says so

An agent runs with its workspace as cwd, and a workspace can be renamed, unmounted, or swept by the OS
between sessions. When `/tmp/codex-probe` disappeared mid-session, the Claude SDK reported **"native
binary exists but failed to launch"** — sending me to inspect a 207MB binary that ran perfectly well
standalone. The runtime checks the path before creating a driver and names the actual problem.

### The diff view

The last piece of M3's exit criterion. A transcript tells you what the agent
*said* it did and which tools it ran; neither is the same as what is now in your
working tree, and that gap is where the review step lives.

`/s/:id/diff` shells out to git and returns the changed files with their line
counts plus a unified patch. Fetched on open rather than rendered into the page
or polled: reading a repository costs a subprocess and most page loads never
open the diff.

**Scope, stated in the UI as well as the code:** this is the workspace's
*uncommitted* state, not per-session attribution. Edits you had in flight before
the session started appear here too. Attributing changes to one session needs a
baseline commit recorded when the session opens, which belongs with the
branch-per-session work in §M6 — claiming it now would be worse than not
offering it, because a wrong attribution is trusted.

The parsers are tested directly because their awkward cases are the ones a
hand-rolled porcelain parser gets wrong, and a wrong path is shown to the user
as a file that does not exist: renames spend two NUL-separated fields, binary
files report `-` rather than a count (`Number('-')` is `NaN`, which renders as
"NaN"), and `-z` exists so a path containing a space or newline survives. A
patch over 512KB is truncated *with a note*, since a diff that stops halfway
reads as a complete one.

Verified in a browser against this repository: five changed files listed with
statuses and counts, untracked files correctly showing no counts rather than
`+0 −0`, and a 7KB patch rendered.

### The surface can now drive itself

The contract allows twelve client commands; the page dispatched **two**. Most of
what a control surface is for was reachable only from the CLI, and two sidebar
buttons that `<Sidebar>` already rendered and emitted for — "New Session" and
the space "+" — did nothing at all.

**Stop** is the one that mattered. A running agent could not be stopped from the
browser. It replaces Send rather than sitting beside it, because while a turn
runs there is nothing to send and two live buttons invite sending into a busy
session. Which button shows is driven by the session state from the log, not by
the click, so a turn started from the CLI or the desktop window puts every open
page into the same state — there is one execution boundary and the UI should
reflect it rather than keep its own idea of what is running.

Interrupting also exposed a real defect. Providers report an abort *as a
failure* — the Claude SDK ends an interrupted turn with
`error_during_execution` — so a deliberate stop landed in the log as
`session.failed`, and the session read as broken when it had done exactly what
it was told. The runtime now drops a provider error that arrives after an
interrupt: the turn is already settled, and reporting it again overwrites "you
stopped this" with "this broke".

| Verified live | |
|---|---|
| Stop appears only while running | Send hidden, Stop shown, from `turn.started` |
| Stop actually stops | deltas frozen at 336, zero after |
| A stop is not a failure | `turn.interrupted` recorded, no new `session.failed` |
| New Session | created in the profile's first workspace |
| New space | profile created from the sidebar's `+` |

One measurement worth recording as a method note: the first interrupt check
*appeared* to fail because `HarnessClient.subscribe` replays from sequence 0, so
the pre-fix `session.failed` still in the log looked like a fresh one. Counting
in the log before and after is what settled it.

### M3 — Web surface *(original scope)*
stx views: profile sidebar (§9), session list, transcript, composer, approvals, diff view. Hydration
per §8's table. Connection supervisor with backoff.
**Exit:** a full agent session driven from a browser, approvals included; the 10k-line transcript
budget from §11 holds.

### M4 — Desktop surface *(measured)*

| Budget | Target | Measured | |
|---|---|---|---|
| Installed size | < 15MB | **1.1MB** release binary | ✅ |
| Cold start → interactive | < 300ms | **~665ms** median | ❌ |

The size budget is not close — Craft's whole thesis, confirmed.

Cold start is now measured **inside the server process**: `markWindowSpawned()` is called immediately
before spawning the window, and the page's own probe POST stamps the arrival. One process, one clock,
covering exactly the window and its page — not the CLI's boot or the SQLite hydrate, which the user pays
once and which say nothing about the page. The earlier 428ms figure came from timing the whole command
from outside and is not comparable; this number replaces it.

**The page-weight hypothesis was wrong, and the experiment says so.** The earlier note blamed the
stylesheet. Measured: the CSS is 31KB, while the *stx runtime* is 159KB, inlined byte-identically on
every request. Lifting the runtime and stylesheet into cacheable assets (see stx #1865/#1878, extended
to SSR) took the page from **392,733 to 213,141 bytes — 46% smaller**. Cold start did not move:

| | median | runs |
|---|---|---|
| inline | 671ms | 667, 693, 676, 667, 722, 667 |
| externalized | 661ms | 662, 712, 658, 661, 774, 653 |

Six interleaved pairs, to cancel drift. The difference is noise. Halving the document changes cold start
by nothing — so the cost is *work*, not payload.

### Where the 665ms actually goes

Decomposed by measurement, not inspection. The control is an **88-byte page** served from a throwaway
server and pointed at by the same Craft flags: it reports when its own JS runs, and it pays everything
except our rendering.

| Phase | ms | how it was measured |
|---|---:|---|
| Craft process start → window created | **165** | `craft --benchmark` prints `ready` at window creation and exits |
| WKWebView cold init + trivial navigation | **~290** | 88-byte control page: 455ms total, minus the 165ms above |
| **harness SSR render of `/`** | **166** | `curl` against a warm server; confirmed against `renderHarnessView` directly |
| harness page parse / execute / layout | **~45** | remainder |
| **total** | **~665** | matches the in-process measurement |

Two conclusions, both actionable:

**The Craft floor alone is ~455ms — over 1.5× the entire 300ms budget.** An 88-byte page cannot beat it.
No amount of work on the harness page can meet the budget while that floor stands, so the budget is a
Craft problem first and a harness problem second.

**The SSR render is the largest harness-controlled slice, and it scales with the number of projects** —
which is exactly the axis a control surface grows along:

| profiles | render | page |
|---:|---:|---:|
| 0 (no sidebar at all) | 21ms | 20KB |
| 1 | 51ms | 268KB |
| 3 | 77ms | 292KB |
| 14 | 175ms | 424KB |
| 14, sessions stripped | 150ms | 375KB |

Each additional profile costs ~9.5ms and ~12KB, and sessions are almost free by comparison (25ms across
all 14) — so the cost is **per-space panel chrome**, not session lists. `<Sidebar>` renders every space's
panel eagerly, even though the Arc design shows one at a time.

**Done, and it landed short of the estimate.** `deferred` shipped in stx 0.2.166: a space keeps its
panel — the track geometry, the tab role, `inert` handling and the swipe all depend on it existing — and
its title, which is what identifies it mid-swipe, and drops the pinned grid, the rows and the actions.
Harness defers everything beyond the active space's immediate neighbours, since those are what a single
swipe can reveal, and `?profile=` makes a space addressable so arriving at a deferred one navigates and
lets the server render it in full. Navigating rather than rebuilding rows in JS keeps a single renderer.

| | before | after |
|---|---:|---:|
| page | 233KB | 167KB |
| SSR render | 166ms | 129ms |
| per deferred panel | 8.8KB | 2.4KB |

A deferred panel is 73% smaller, but the total only fell 22% — because the cost was never the rows. The
earlier measurement said so and I read it too optimistically: stripping every row from all fourteen
spaces saved 25ms, so the ~9.5ms per space is the **panel shell**, not its contents. Deferral removes
what it can; the remaining 2.4KB is the section, the scroll container and the title. Getting to the
predicted ~70ms would mean not emitting the shells at all, which the track geometry currently needs.

Verified in a browser: 12 of 14 panels deferred, every deferred panel keeps its label and has no rows,
clicking a deferred space navigates and comes back with that space rendered in full, and clicking a
neighbour switches instantly with no round trip.

The externalization stays regardless: on localhost bytes are free, but the web surface is not localhost,
and ~190KB per request that no browser could cache was waste whatever the cold-start number says.

Native surfaces verified in a live window rather than inferred: `window.craft`, `window.craft.gestures`,
`nativeUI`, and `createSpacesSidebar` all present, with `<SidebarSpaces>` binding the native rail
(`spacesBound: 1`, three profiles, an active space).

### Per-profile tint — the Arc idea was never actually wired

A space having a *feel* is the whole premise of §9, and every space rendered blue. The break ran through
three layers, each of which looked fine on its own:

| Layer | State |
|---|---|
| `profile.create` command | accepted `icon` and `tint` |
| `profile.created` event | **dropped both** |
| `profile.update` | in the client allowlist, **no reducer case at all** |
| `ProfileState` | **had neither field** |
| `ViewProps` | declared both, could never fill them |

Fixed the length of the chain, with `profiles:set` to change a profile's name, colour or icon from the
CLI. An update carries only the fields that changed, so recolouring a space cannot quietly rename it.

The native half then failed differently. `setBackgroundColor("violet")` logged `r=1.00 g=1.00 b=1.00` —
craft understood `#RRGGBB` and silently painted **white** for anything else, which to a caller is
indistinguishable from a colour that worked. Fixed upstream with a real parser (`#RGB`, `#RGBA`,
`#RRGGBB`, `#RRGGBBAA`, and all 148 CSS names) that refuses what it cannot read; released as
**craft v0.0.64**. `violet` now lands as `r=0.93 g=0.51 b=0.93`.

Worth noting that this could not have worked at all before **craft v0.0.62** either — `setBackgroundColor`
was one of the twenty window actions whose payload the bridge discarded (§10.10). Three independent
defects stacked between "the model has a tint column" and "the window is violet".

### Global shortcut

`Cmd+Shift+H` focuses the window and puts the cursor in the composer. Registered from the page rather
than from the Zig host, because the handler is page logic; the host owns the hotkey and delivers a
`craft:shortcut` event carrying the id, so the page never holds a callback the OS knows nothing about.

Verified as far as the boundary allows: the bridge receives
`{"a":"register","t":"shortcuts","d":"{\"id\":\"harness.summon\",\"accelerator\":\"Cmd+Shift+H\"}"}`
with no error. **Actually pressing the keys needs a person at the machine** — as with the trackpad swipe.

A wrong turn worth recording: `craft-app.js` exposes `app.registerShortcut(accelerator, handler)` and is
never injected. The live surface is `craft-bridge.js`, whose API is
`shortcuts.register(id, accelerator)` plus a `shortcuts.on` event. Reading the file that looked right
cost more than probing the running page would have.

### Still open in M4

**`.dmg` packaging and the Craft updater.** Craft has release workflows and an updater bridge already;
wiring them for harness is real work, but a signed `.dmg` cannot be verified here without signing
credentials, and shipping an unverifiable installer is worse than not claiming one. Left deliberately.


### M4 — Desktop surface *(original scope)*
Craft window over the server. Native chrome: per-profile titlebar tint, system tray, global
shortcut, native spaces sidebar (§10.2) mirroring the web one. Craft updater.
**Exit:** a signed `.dmg` under 15MB that cold-starts under 300ms, both measured in CI.

### M5 — The rest of the drivers *(all five implemented)*

| Driver | Transport | State on this machine |
|---|---|---|
| claude | Agent SDK | ready — turns verified live |
| codex | `app-server`, JSON-RPC/stdio | implemented and **verified live end to end** |
| cursor | ACP (`cursor-agent acp`) | implemented over the ACP client; live turn gated on `cursor-agent login` |
| grok | ACP (`grok agent stdio`) | one `createAcpDriver` call; live turn gated on `grok login` |
| opencode | ACP (`opencode acp`) | one `createAcpDriver` call, **conformance green against the live agent** |

**The conformance suite is the deliverable**, not the driver count. It states the ordering invariants
the engine silently assumes — exactly one terminal event per turn, no tool result without its call, at
most one session binding per turn, non-negative integer usage, idempotent interrupt and approval, clean
teardown — and each case carries *why* it matters, so a failure reads as a diagnosis. Its own tests use
fakes that each break exactly one invariant, so the suite is proven to fail as well as to pass.

Codex was written against the protocol the CLI generates for itself
(`codex app-server generate-json-schema`), not against guesswork. Two findings that only a live run
produced:

- Codex emits an `error` notification **and then** a failed `turn/completed`. Emitting on arrival would
  end every failed turn twice. Holding the error until completion is verified live: a usage-limited turn
  produces two events and exactly one terminal.
- The `thread/start` enums are kebab-case; `onRequest` was rejected only *after* a thread had started.
  Pinned by test. The policy is `untrusted`, not `on-request` — on-request lets the model decide when to
  ask, and harness's contract is that the user owns that decision.

The unimplemented drivers are **registered, not absent**. A registered driver reports "not
installed" or "installed but the driver is not implemented yet"; an absent one reports "no driver for
cursor", which the user cannot act on. `startTurn` throws rather than returning an empty stream, because
a silent turn is indistinguishable from an agent with nothing to say.

`./buddy harness:doctor [--conformance]` probes every driver and runs the spec against them.

**Codex, verified live** once the account's quota reset. A turn returning `ok` (12,506 in / 22 out), and
a tool-using turn producing exactly the sequence the driver promises:

```
session.created
turn.started
session.provider-bound      ← the thread id, so the next turn resumes
tool.call.began   | shell   ← Codex's commandExecution item, translated
tool.call.ended   | ok
turn.completed    | 12701 tokens
```

Cost reads `$0.0000` because Codex reports tokens and not cost; the driver returns 0 rather than
inventing a number from a price table that would silently go stale.

One environment note that is not a harness bug: the account's default model is `gpt-5.6-sol`, which this
CLI build refuses with "requires a newer version of Codex". Passing `--model gpt-5.4-mini` works, and the
error is now readable rather than a raw JSON blob (§10.13's `readableError`).

### The ACP client, and cursor over it

`packages/drivers/src/acp.ts` is the priority abstraction §7 called for: JSON-RPC v2 over stdio —
`initialize` → `session/new` → `session/prompt`, with `session/update` notifications streaming while
the prompt runs. The protocol lives there once; a provider is a `createAcpDriver` call naming its
binary, its ACP argv, and how its CLI reports auth. Three shape differences from Codex worth writing
down:

- **The prompt's *response* ends the turn**, not a separate notification — the `stopReason` in the
  `session/prompt` result is the terminal event. `cancelled` completes rather than errors: the user
  asked for the stop, and an error would blame them for it.
- **Permission answers name an option the agent offered**, not a bare boolean. An allow picks the
  least-privileged allow on offer (`allow_once` before `allow_always` — the user approved *this*
  call, not every future one), and a decision with no matching option answers `cancelled`.
- **`session/load` replays the whole conversation** as `session/update` notifications before its
  response arrives. The client drops them while the load is in flight — they are history the
  transcript already has, and emitting them would duplicate every prior turn on resume.

Three wire facts were recorded off the live binary rather than guessed, because none of them are in
`cursor-agent --help`: the `acp` subcommand **exists but is hidden** (found by handshaking it
directly; it answered `protocolVersion: 1`, `loadSession: true`); `acp --model <m>` is accepted;
and `cursor-agent status` exits 0 *whether or not you are logged in* — printed text is the only
auth signal, so the probe reads it, the same trick the codex probe uses. The unauthenticated
`session/new` error carries the actionable sentence in `error.data.message`, not `error.message` —
`readableAcpError` prefers the detail, pinned by a test against the recorded frame.

**Verified live while logged out** (installed 2026.08.11-e8db854, no Cursor account on this
machine): probe reports `unauthenticated` with "run `cursor-agent login`", a real turn spawns the
process, handshakes, and ends with exactly one terminal event carrying the agent's own actionable
auth message, and conformance passes by declining cleanly. **A logged-in turn is the remaining
verification** — the login is a browser flow only a human can complete, and claiming the driver
works end to end before one ran would be exactly the kind of claim this file exists to prevent.

### OpenCode — the ACP bet paying out

The plan budgeted a bespoke runtime for opencode ("own CLI/HTTP runtime, needs CLI output
parsing", per t3code's provider map). By the time M5 reached it, opencode 1.18 shipped a
*documented* `opencode acp` server — so the driver is one `createAcpDriver` call naming the binary
and the argv, and nothing else. This is exactly the payout §7 predicted when it made ACP the
priority abstraction: the second ACP provider cost a config object, not a transport.

Two findings only the live CLI produced:

- **Credentials are optional, so the probe must not demand them.** A turn completes on the free
  tier (`opencode/big-pickle`) with `opencode auth list` reporting 0 credentials — verified live —
  so `createAcpDriver`'s auth check became optional, and opencode omits it. A probe that said
  `unauthenticated` there would gate a provider that works out of the box.
- **It is the first driver whose full conformance spec ran green against the live agent** — probe
  ready, a real turn (3 events, exactly one terminal), idempotent interrupt/approval, clean
  teardown. Claude and codex were verified by hand before the suite existed; cursor declines
  cleanly until a login exists. Resume is verified live too: a second instance given the
  `providerSessionId` answered with the word the first turn planted ("pineapple"), and the
  `session/load` replay produced no duplicate history in the stream — the suppression works
  against a real agent, not just in the unit test.

### Grok — the claim "not installable" went stale too

The section above once said the grok CLI was not installable here. Checked again a phase later:
xAI's official **Grok Build** CLI (binary `grok`, `xai-org` on GitHub, beta since May 2026)
installs from `x.ai/cli/install.sh` and speaks ACP — the invocation is `grok agent stdio` with
`-m <model>` between `agent` and `stdio`, the shape Zed's ACP registry launches, not a `grok acp`
subcommand. So the driver *was* one `createAcpDriver` call, as predicted. Wire facts recorded off
grok 1.0.3: there is no `auth status` subcommand — `grok models` exits 0 either way and prints
"You are not authenticated." when logged out, so the probe reads that; the unauthenticated
`session/new` error carries `data` as a plain *string* ("no auth method id provided"), which
`readableAcpError` already skips in favour of the message. Verified live while logged out: probe
`unauthenticated` with "run `grok login`", a real turn ends with exactly one readable terminal
error, conformance declines cleanly.

With that, **every provider in the contract has a real transport**, and the old stub file
(`cli-driver.ts`) is reduced to the probing helpers the drivers share. The conformance suite's
"awaiting a transport" section became "an absent CLI is a state, not a crash" — the one rule from
the stub era that still binds every driver.

**Still open in M5:** logged-in live turns for cursor and grok — both logins are browser flows
only a human can complete. Claude, codex and opencode are verified live end to end.

### M5 — The rest of the drivers *(original scope)*
ACP client, then Cursor and Grok as extensions over it. Codex app-server. OpenCode runtime.
Conformance suite green for all five.
**Exit:** every provider passes the same spec; adding a sixth is a weekend.

### M6 — Depth *(checkpoint and revert done)*

**Undo a turn.** An agent that edits eleven files and gets the ninth wrong is the normal case. A diff
tells you it happened; a checkpoint is what takes it back.

The snapshot uses a **temporary index**, not the stash and not a commit on your branch:

```
GIT_INDEX_FILE=<temp> git read-tree HEAD
GIT_INDEX_FILE=<temp> git add -A
GIT_INDEX_FILE=<temp> git write-tree      -> tree
git commit-tree <tree> -p HEAD            -> commit
```

Nothing the user owns moves: their index is untouched, the branch does not advance, the stash list does
not grow, no file changes. The result is a dangling commit reachable by SHA. `git stash` was rejected
precisely because it mutates — it reverts the working tree as a side effect of saving and pushes onto a
list people use by hand, and a harness that quietly consumed someone's stash stack would be worse than
one with no checkpoints.

Restoring has **two halves**, and the second is the one that is easy to forget: files the checkpoint
recorded are written back, *and* files created since are removed. Restoring only what was recorded
leaves the agent's new files behind, producing a state that never existed — worse than not reverting,
because it looks like it worked. Ignored files are never touched; `node_modules` is not in a checkpoint
and must not be deleted by one.

Captured **before** the agent runs and awaited, not fired off: a checkpoint taken after the first edit is
worse than none, because it looks like a safe point and is not. Skipped silently for a workspace that is
not a repository, since a turn must not fail for that.

A revert is refused while a turn is running. Restoring files under a working agent leaves it editing a
tree that changed for reasons it cannot see, and the resulting diff belongs to nobody.

**Verified live:** an agent rewrote `README.md` to `AGENT WAS HERE`; clicking *Revert this turn* in the
browser restored `the original line` and left `git status` empty.

### Two defects this uncovered

**Every manually-approved tool call was failing.** The SDK's permission callback returns
`{ behavior: 'allow', updatedInput }`, and `respondApproval` omitted `updatedInput`. Auto-approve passed
it and manual approval did not, so every tool a *human* allowed failed while every auto-approved one
worked — the safety-critical path was the broken one. The agent diagnosed it better than the logs did:
*"there's an internal problem with how the permission requests are being structured."*

**A client that dies mid-approval wedges the turn.** The agent asks, nobody answers, and the session sits
`running` forever — unable to revert, since a revert is refused mid-turn. Stop settles it, which is what
that button is for, but a turn should not depend on a person noticing. Worth a timeout or a
reconnect-aware default.

### Replay did not follow the log's order

Found while tidying test profiles, and the most serious thing in this stretch.

`hydrate()` replayed **session by session**, concatenating each session's events.
But `seq` is *per session*, so that reconstructs a reordering of the log rather
than the log. A `profile.deleted` written last was applied before the
`session.created` events it was meant to remove — and recreated them. The
projection came out as a state that never existed, which is the one thing an
event log exists to make impossible.

Measured on the real database: 18 sessions belonging to deleted profiles were
still present after a restart, reachable from no view and impossible to delete,
because the only handle on them was a profile that no longer existed.

Replay now reads the whole log in append order (`readAll`, ordered by rowid —
the only total order the log has). The 18 orphans disappeared on the next
hydrate, with no manual surgery: the events were always right, only the reading
of them was wrong.

`profile.delete` also cascades now, recording the workspaces and sessions it
removed on the event rather than re-deriving them at replay time.

### Two halves of a revert

`checkpoint.reverted` says a revert was *accepted*; the git work runs after it.
The UI reloaded on that event and landed in a half-restored tree — files
rewritten, files the agent added not yet removed. A test polling one file passed
for the same reason. `checkpoint.restored` now reports the finished job with its
counts, and both the UI and the test wait for it.

### A stuck approval no longer strands a turn

Two separate failures wore the same face — a session sitting `running` that
would accept neither a new turn ("a turn is already running") nor a revert
(refused mid-turn), so the only recovery was for a person to notice and press
stop. It cost me time three times before I fixed it.

**The client died, the server lived.** An approval only ever reached whichever
client was connected when it fired. Anyone arriving afterwards saw
`awaiting-approval` and nothing to act on. The pending decision is now part of
the session projection and rendered server-side, so *any* client can answer it —
verified by loading a wedged session in a browser that had never been connected
and seeing the panel with the tool and its id.

**The server restarted.** A turn only runs because a provider instance is
running it, and those die with the process. Replay faithfully restored the
session as `running`, which is what the log says, but nothing was going to
finish it. `serve()` now closes out turns left in flight, recorded as an
interruption so the log says what happened rather than being quietly rewritten.
Verified live: restarting a server with a wedged session appended
`turn.interrupted`, and the session came back usable.

A third bug fell out. The island collapsed every non-`running` state to `idle`,
overwriting the server's `awaiting-approval` — so a session waiting on *you*
looked like one doing nothing, and it offered Send instead of Stop on a turn
that had not finished. The state string is now authoritative rather than a
boolean.

### The diff now attributes to the session

`/s/:id/diff` measured the working tree, so edits you had in flight before the
session started appeared as the agent's, and work the agent *committed*
disappeared entirely — `git diff HEAD` is empty once it commits, and the panel
said "no changes" about a session that had rewritten a file.

It measures against the session's **first checkpoint** now. No new bookkeeping
was needed: checkpoints already exist so a turn can be undone, and the earliest
one *is* the baseline. A second marker beside it would have been one more thing
to keep in step.

Both sides are trees. Comparing a baseline tree against the live *index* reports
a file that is present but untracked as **deleted** — it is in the tree, absent
from the index, and git cannot tell you still have it. Snapshotting the working
tree the way the checkpoint does makes the comparison symmetric, and brings
untracked files in on both sides for free. That also turns a new file from
`untracked` with no counts into `added` with real ones, which the working-tree
view cannot manage.

The response says which comparison it made, and the UI says it too — "since this
session started" or "in the working tree". A baseline that `git gc` has
collected falls back to the working tree rather than claiming an attribution it
no longer has.

**Verified live:** an agent appended a line and committed twice. `git diff HEAD`
was empty; the panel reported `scope: session`, one file, `+1 −0`, with the
agent's line in the patch — and left the edit I had in flight before the session
out of it.

### A checkout per session

Sessions share a workspace by design — `harness:run` reuses one by path, and a
profile's project is one directory. That is fine until two run at once: they
edit the same files, each sees the other's half-finished work, and a revert in
one throws away the other's. The transcript then describes changes that are not
the ones on disk.

`--isolate` gives a session `git worktree add -b harness/session-<id>`. A branch
alone would not do: `git switch -c` gives a session its own *branch* but not its
own *files*, and switching the working tree under a running agent changes files
out from under a process mid-edit.

Worktrees live under `.git/harness/worktrees/<id>` — inside the git directory,
so there is nothing to gitignore and nothing to commit by accident, while
`git worktree list` still finds them. Created on the first turn rather than at
session creation, so a session nobody runs leaves no checkout behind. A
workspace that is not a repository runs where it is, because `--isolate` should
not be a footgun on a plain directory.

**Each turn is a commit.** A worktree alone leaves the work uncommitted, so the
branch is an empty pointer beside a dirty checkout and `git merge` gets you
nothing. Every turn that changed something commits onto the branch, so the
history reads one commit per turn. The author comes from the repository's own
config, falling back to a harness identity only where none is set — `-c`
overrides rather than fills, so a blanket default would rewrite the author on
every machine that had one.

Nothing merges anything back. `harness/session-<id>` is a branch you merge,
rebase or open a PR from with the tools you already have.

**Verified live with two agents at once**, both told to rewrite the same file in
the same repository:

| branch | `shared.txt` |
|---|---|
| `harness/session-918007568` | `AGENT ONE` |
| `harness/session-919239881` | `AGENT TWO` |
| workspace, on `main` | `shared file` — untouched |

Everything downstream followed the worktree without knowing it existed: the
agent's cwd, the checkpoints, the diff. `defaultWorkspacePath` returns the
worktree when there is one, and that is the whole integration.

### MCP servers, per profile

A profile carries its own servers, because a work project wants its issue
tracker and a personal one should not inherit its credentials. `mcp:add`,
`mcp:list`, `mcp:remove`, `mcp:enable`, `mcp:disable`; the runtime resolves a
profile's enabled servers and hands them to the driver, which maps them onto the
SDK's own `mcpServers`.

**A secret is referenced, not stored.** A value may be `${NAME}`, resolved from
the server process's environment at spawn. The log — plaintext SQLite, designed
never to forget — holds `${DEMO_WORD}`; the agent's process holds the value.

Verified end to end rather than asserted: with `DEMO_WORD=pomegranate` in the
server's environment and a demo server configured with
`{"HARNESS_DEMO_WORD": "${DEMO_WORD}"}`, the agent called
`mcp__demo__harness_secret_word` and answered *pomegranate*.

The honest boundary, found by grepping the log afterwards: one row did contain
the word — the assistant's own reply, because I had asked it to say it. The
guarantee is about what harness writes, not about what an agent can be talked
into saying. Written into the module doc so the next reader gets the true
version.

**The bug this surfaced.** Two live attempts failed with the tool missing, and
the cause was not MCP at all: `HarnessClient.state` was only built from events
for *subscribed* sessions, and nothing subscribed to the global one. So
`harness:run`'s "reuse a workspace by path" check always found nothing and made
a **new profile every run** — five `CLI` profiles had accumulated, and the
server was attached to a different one than the run used. `connect()` now
hydrates from the global session before returning. The feature was fine; the
client had been quietly lying about what existed since the day it was written.

### Remote access, and the check that quietly stopped being one

The server is the only thing that executes anything, so driving harness from a
phone was always meant to fall out of the architecture. What stood in the way
was that it had **no authentication at all** — the protection was the bind
address, `127.0.0.1`, and the reasoning was sound: anything already on this
machine can run processes as you.

That reasoning survives exactly until someone puts a tunnel in front of it.

**A tunnel connects to localhost.** Every request it forwards arrives from
`127.0.0.1`. So "this came from my machine" silently becomes "this came from my
machine, or from anyone on the internet who found the URL", and nothing can tell
the two apart. A peer-address check does not fail loudly here — it keeps
returning `true` and stops being a check. Reaching this socket means starting an
agent, and an agent runs tools, so that is remote code execution.

So there are two modes and no gradient between them:

| | bind | authentication |
|---|---|---|
| **local** (default) | loopback | none — the boundary *is* the bind address |
| **remote** (`--remote`) | every interface | every connection, **loopback included** |

Exempting loopback in remote mode would exempt the tunnel, which is the entire
problem. Local clients keep working by reading a token from a `0600` file, the
way docker and Jupyter do it; the desktop window gets a one-time `?token=` in
its URL that the server swaps for a cookie and redirects away.

Binding a public interface without `--remote` **refuses to start** rather than
warning: by the time a warning is read, the port is open.

**Pairing.** The host shows an eight-character code (no `0`/`O`/`1`/`I`), good
for five minutes and one use, burned after five wrong guesses. The phone opens
the URL, types it, and gets a cookie — `HttpOnly`, `SameSite=Strict`, and
`Secure` only over https, because setting it on a plain-http LAN address means
the cookie is silently never stored.

**What the log stores is a SHA-256, never the token** — same reasoning as the
MCP secrets above, and this time the property is total: verified zero rows
containing an issued token, one row holding its hash.

**Revocation had to reach the connection, not just the next handshake.** The
first version authenticated at upgrade, which meant a revoked phone kept the
socket it already held — free to keep dispatching, indefinitely. Sockets now
carry their device id and are closed as the `device.revoked` event broadcasts.
And `harness:revoke` dispatches *through* the running server rather than
straight to the log: writing to the log directly would leave that process
holding a projection where the device was still paired, so it would go on
honouring the token — the one thing a revoke must not do.

Verified live, end to end: a public bind refused; an unauthenticated browser got
the pairing page and an unauthenticated API call got 401; `/health` answers
everyone but discloses counts to no one; a wrong code decremented; the right one
paired; `harness:run` kept working through the token file; and a revoked iPad
watching a live socket saw `closed(4001) access revoked` with its cookie 401ing
on the next request.

### Reaching it from outside the network

Pairing solves the phone on your sofa; it does not solve the phone on a train,
because a LAN address is not routable from anywhere else. `--tunnel` closes
that, over first-party `localtunnels` (0.2.12, exact-pinned).

**It refuses to run without authentication.** A public URL in front of harness
is remote code execution with a link, and the check that would have caught it
cannot — the tunnel forwards from loopback, so every relayed request looks
local. That is a refusal rather than a warning, and it is checked *before the
socket binds*: opening the tunnel is the last thing `serve` does, so refusing at
that point would leave a bound port and an open database behind. Verified — the
first version did exactly that, and the test caught it by finding its own port
in use on the next case.

**A plain-http relay is refused too**, because it would read every prompt and
every file the agent touches. Loopback relays are exempt: `127.0.0.1` is not a
third party and the bytes never reach a network. Encoding that distinction
matters more than the convenience — a rule that obstructs the harmless case is
how a security check earns a reputation for being in the way and gets switched
off.

Verified end to end against a relay **running on this machine**, so nothing was
published to the internet to prove the path: a request arriving through the
tunnel reached harness and got `401` with the pairing page — the tunnel
forwards, and a stranger holding the URL gets nowhere without a code.

### Worktrees are given back now (harness/harness#10)

`--isolate` created `.git/harness/worktrees/<session>` and nothing ever removed
it, so a deleted profile left a full checkout per isolated session on disk.

The rule that decided the design: **the branch is the deliverable, the directory
is scratch — and uncommitted agent output is never discarded to tidy up.**
`release` commits whatever the worktree still holds onto the session's own
branch first, *then* removes the directory. Refusing to clean up while a stray
file sits there is how the directories accumulate; deleting that file to get on
with it is worse. Committing is the only option that loses nothing.

`harness:worktrees` lists them with their branch and whether they are dirty,
`:prune` clears registrations whose directories are gone, and `:remove` releases
one by hand — visible before anything automatic starts deleting.

Verified live: an isolated session's work committed per turn as `harness: turn
1`; a file left uncommitted in the worktree, as a crashed turn would leave it,
came back as `harness: work left uncommitted when the session went away`; the
directory was gone and the branch still there.

**A wart this exposed, now closed.** The server-side hook did not fire for
`profiles:delete`, because that command dispatched to *its own* engine over
SQLite — so a running server never saw it and went on serving a projection
built before it happened. Every mutating CLI command did this.

"A CLI command is a client like any other" was true of the log and false of the
server. It is now true of both: `app/Support/dispatch.ts` sends through the
socket when something is listening and writes to the log when nothing is, and
every mutating command goes through it. Both paths append the same events in
the same order; the difference is only whether the process holding the read
model finds out.

The alternative — having the server watch the log — would work and would be
worse: it would have to reconcile events it did not cause against reactions it
must not run twice, and "did I already act on this?" is the question command
receipts exist to stop anyone asking.

Verified both ways on the bug that exposed it. With a server running, deleting
a profile releases its worktrees *in the server* (its own log says so) and the
CLI stays quiet rather than reporting a removal another process performed; with
no server, the CLI does it and says so. Directory gone, branch kept, either
way.

### Scan-to-pair, and a bug found looking for it

Typing `KJ3E-EJ6Y` into a phone is fine; scanning a code that carries both the
URL and the pairing code is better, and first-party `qrx` should have provided
it. Two things were in the way, both now fixed upstream
(stacksjs/ts-qr-codes `fee02e4`):

1. **Every QR it generated was undecodable.** `setupPositionProbePattern`
   assigned `true` in *both* branches of its if/else, so the 8×8 finder region
   came out solid — no ring, no separator. A scanner that cannot find three
   finder patterns cannot read the code at all, and every renderer in the
   package drew that. Proven rather than argued, with the system's own
   detector: `DECODE FAILED` before, decoded after.
2. **It capped at version 5.** The capacity table was five rows followed by
   `// ... truncated for brevity ...`, so anything over 106 characters threw.
   The Reed-Solomon and alignment tables were complete all along.

It also had no way to encode without a DOM, which is why a server could not use
it; `toMatrix` and `toTerminal` fix that.

Harness cannot adopt it yet — the package is unpublished, and `@stacksjs/qrx`
on the registry predates the fix, so depending on it today would ship the
broken encoder. Pairing stays type-a-code until there is a release.

### M6 — still open
Terminals. The blocker was "no first-party terminal emulator; nothing that
renders ANSI" — that piece now exists. `packages/ansi` is the emulator *core*:
a pure state machine from escape stream to cell grid (SGR in all three color
widths, cursor addressing, erase, deferred wrap, scrollback, the alternate
screen), with one HTML renderer both consumers share — a terminal surface
paints a viewport, a transcript paints a snapshot. Tested against recorded
output (a live `git -c color.diff=always diff`, which also pinned git's bare
`\x1b[m` reset spelling), and honest about its punts: scroll regions, glyph
width, tab stops. One decision worth its comment: `\n` converts to `\r\n` by
default, because the near consumer is *piped* tool output where no PTY line
discipline has done the translation — a strict emulator renders every such
stream as a staircase; a future PTY transport passes `convertEol: false`.

The PTY transport exists too, and it took no native dependency: `script(1)`
runs the shell under a real pseudo-terminal on every machine this server
targets, with the BSD/util-linux spellings pinned in `packages/server/src/pty.ts`.
The fact that cost the debugging session: both runtimes hand children
*socketpairs* for piped stdio on macOS, and BSD `script` dies on a socket
stdin ("tcgetattr/ioctl: Operation not supported on socket") while tolerating
a real pipe — so a load-bearing `cat |` sits in front, converting one to the
other. Terminal I/O rides the socket as ephemeral frames
(`term-open/input/close` in, `term-opened/data/exit/error` out) — deliberately
*not* events: bytes are a live stream, not history, and the append-only log
must not become a keystroke recorder. Two boundaries hold: a terminal dies
with the socket that owns it (a PTY with no reader is a shell running
unwatched), and `term-open` is refused for paired devices — a terminal is
arbitrary execution with no approval step in front of it, and until §12 has a
story for that over remote access, terminals belong to this machine only.
Verified by a live test: open over the socket, `echo "m-$((40+2))"` typed in,
`m-42` streamed back — computed by the shell, so it proves execution, not echo.

What remains: the surface (a terminal panel rendering `@harness/ansi`'s
`toHtml` over `term-data`, web first, desktop reusing the same view) and live
resize, which `script` cannot do — that one genuinely waits on a native ioctl
shim or craft's `bridge_shell.zig` growing one.

### M7 — Mobile
Craft iOS/Android over the same views. The swipe is native here and the Arc sidebar is the natural
navigation model. This is where the design pays off most.

---

## 16. Risks

| Risk | Mitigation |
|---|---|
| Craft's NSEvent scroll-phase work is the deepest unknown in M0 | stx's wheel fallback already ships and works; native is an upgrade, not a blocker. The JS/SDK surface can land ahead of the Zig path. |
| Bun 1.4.0 lands next week and something adopts it by accident | §2 + §10.7: exact pins, lockfile guard, CI version assertion. Three independent nets. |
| Agent CLIs change protocols without notice | Conformance suite nightly against real CLIs; pinned known-good versions; fail loudly, never silently degrade. |
| SSR-first is wrong for a streaming transcript | Prove it against the 10k-line/4ms budget in M3, **before** M7 commits mobile to the same views. |
| Event-sourcing overhead makes writes slow | Measure in M1 with the 20-session budget. The fallback is snapshotting projections, not abandoning the log. |
| We reimplement Stacks features inside harness | Anything that generalises gets promoted upstream, not copied. Reviewed at each milestone boundary. |
| Scope creep into the runtime | §17 is a document, not a backlog. Nothing in M0–M7 depends on it. |

---

## 17. Deferred: the runtime

Not built in v1. Documented so the boundaries above stay honest, and so this is additive when we want
it.

### 17.1 What it would be

A first-party agent loop registered as one more entry in the driver registry — `driverKind: 'harness'`
beside `'claude'` and `'codex'`. Everything above the driver boundary (engine, contract, views,
sidebar, checkpointing, approvals) is unchanged. That is the entire reason the boundary is drawn
there and not somewhere more convenient.

### 17.2 Pieces, and what already exists

| Piece | pi's version | Stacks today |
|---|---|---|
| Multi-provider LLM API | `packages/ai` (OpenAI, Anthropic, Google, Bedrock, Ollama) | `core/ai/src/drivers/{anthropic,openai,ollama,claude-agent-sdk}` — real, needs a unified surface |
| Agent loop | `packages/agent` — `agent-loop.ts`, tool calling, state | `core/ai/src/agents/claude` — thin. **The loop is the gap.** |
| Tools | `coding-agent/src/core` — bash executor, fs, edit, search | `core/shell`, `core/storage`, `core/search-engine` exist as libraries; not exposed as agent tools |
| MCP client | `coding-agent` MCP integration | `core/ai/src/mcp.ts` — stdio, SSE and streamable-HTTP transports. **Done.** |
| Model catalog | generated `models.generated.ts` + hydration scripts | none — would need building |
| Sessions / compaction | `core/compaction`, `session-manager.ts` | harness's event store covers persistence; compaction is new work |
| Extensions | `coding-agent/src/extensions` — custom providers, sandbox | Stacks Actions + `app/Skills/` are the natural analogue |
| TUI | `packages/tui` — differential renderer | none, and none wanted — see below |
| Wire protocol | `packages/protocol/cbor` | harness's contract package already CBOR |
| Telemetry | `packages/telemetry` — vendor-neutral contracts | `core/analytics` to build on |
| Evals | `packages/evals` | none; meaningless before we own a loop |

### 17.3 What we would do differently from pi

- **No separate TUI runtime.** pi's TUI talks to an in-process agent, so a terminal session is
  invisible to any other surface. Ours is already a client of the same server, so it isn't.
- **Permissions as a first-class layer.** pi ships none by design and tells you to containerise.
  We already have §12; agent tool calls route through it rather than around it.
- **Sandboxing at the driver boundary**, using Craft process isolation plus Stacks' shell layer,
  rather than a bolt-on extension.
- **Model catalog generated and checked in**, like pi's — the one part of their design to copy
  almost exactly.

### 17.4 Other deferred features

Team/multiplayer (several people on one profile, presence on a session) — cheap on an event-sourced
engine, impossible to retrofit onto mutable state. Part of why M1 is shaped as it is.

---

## 18. Conventions

From `~/Code/stacks/AGENTS.md`, non-negotiable:

- **Bun 1.3.14 exactly** (§2) — verify with `bun --version` inside `pantry env` before any install
- **pickier** for lint (`./buddy lint:fix`), never eslint
- **stx** for templating — no `var` / `document.*` / `window.*` in templates
- **Crosswind** for CSS
- **better-dx** for shared dev tooling; do not re-declare what it ships; `bunfig.toml` sets
  `linker = "hoisted"`
- No Bun `catalog:` protocol — every range lives in the `package.json` that declares it
- **buddy-bot** for dependency updates, not renovate
- Conventional commits; branch off `main`, never commit to it directly
- SQLite >= 3.47.2, git >= 2.47.0
- Every dependency first-party, from `~/Code/**`
- Fix at the source. No workarounds, ever.
