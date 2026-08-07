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
session.create            { workspaceId, driverKind, providerInstanceId }
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
| `grok` | **ACP** | plus an xAI extension layer |
| `opencode` | own CLI/HTTP runtime | needs CLI output parsing |

**Design consequence: ACP is the priority abstraction.** Two of five providers speak it today and
the direction of travel is toward more. `packages/drivers/acp` is a real ACP client — JSON-RPC
framing, session lifecycle, tool-call and permission-request mapping — and Cursor and Grok are thin
extensions over it. Claude, Codex and OpenCode are bespoke.

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

## 11. Performance budgets

Enforced in CI. stx already has `scripts/performance-budgets.ts`; mirror the approach.

| Metric | t3code (Electron) | harness budget |
|---|---|---|
| Desktop cold start → interactive | ~1–2s | **< 300ms** |
| Desktop installed size | ~150MB | **< 15MB** |
| Idle RSS, one session open | ~250MB | **< 60MB** |
| Session-list first paint, 500 sessions | — | **< 50ms** (SSR shell) |
| Transcript append, 10k-line session | — | **< 4ms** frame budget |
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
| Drivers | The conformance suite (§7) against fakes in PR CI, against real CLIs nightly. |
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

### M1 — Skeleton
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

### M3 — Web surface
stx views: profile sidebar (§9), session list, transcript, composer, approvals, diff view. Hydration
per §8's table. Connection supervisor with backoff.
**Exit:** a full agent session driven from a browser, approvals included; the 10k-line transcript
budget from §11 holds.

### M4 — Desktop surface
Craft window over the server. Native chrome: per-profile titlebar tint, system tray, global
shortcut, native spaces sidebar (§10.2) mirroring the web one. Craft updater.
**Exit:** a signed `.dmg` under 15MB that cold-starts under 300ms, both measured in CI.

### M5 — The rest of the drivers
ACP client, then Cursor and Grok as extensions over it. Codex app-server. OpenCode runtime.
Conformance suite green for all five.
**Exit:** every provider passes the same spec; adding a sixth is a weekend.

### M6 — Depth
Checkpointing and revert. Git integration (branch/worktree per session). Terminals. Per-profile MCP
server management. Remote access from a phone — auth and pairing, since the server is already the
boundary.

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
