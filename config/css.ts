/**
 * Crosswind (utility CSS) — content globs plus the app's hand-written rules
 * as typed preflights. A `.stx` file carries no `<style>` block (stx-standards
 * §11.1): tokens and stateful selectors live here, once, and land inside the
 * one generated stylesheet.
 * @see https://github.com/cwcss/crosswind
 */
import type { CrosswindConfig } from '@cwcss/crosswind'
import { TERMINAL_CSS } from '@harness/ansi'

/**
 * `hidden` must always mean hidden. A display utility on the same element
 * (the profile modal's `flex`) is an author rule and outranks the UA sheet's
 * `[hidden] { display: none }`, which left a "hidden" overlay covering the
 * page and swallowing every click — caught by the page drive.
 */
const HIDDEN_PIN = '[hidden] { display: none !important; }'

const TRANSCRIPT_MARKDOWN = `
.transcript-markdown {
  display: flow-root; min-width: 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere;
}
.transcript-markdown > :first-child { margin-block-start: 0; }
.transcript-markdown > :last-child { margin-block-end: 0; }
.transcript-markdown :where(p, ul, ol, blockquote, hr, .transcript-code, .transcript-table) { margin-block: 0.65em; }
.transcript-markdown :where(h1, h2, h3, h4, h5, h6) { margin-block: 0.8em 0.3em; font-weight: 650; }
.transcript-markdown :where(h1, h2) { font-size: 1.18em; }
.transcript-markdown :where(ul, ol) { padding-inline-start: 1.6em; }
.transcript-markdown ul { list-style: disc; }
.transcript-markdown ol { list-style: decimal; }
.transcript-markdown blockquote { border-inline-start: 2px solid rgb(127 127 127 / 42%); padding-inline-start: 0.8em; }
.transcript-markdown a { text-decoration: underline; text-underline-offset: 2px; }
.transcript-table-scroll { overflow-x: auto; }
.transcript-table table { width: 100%; border-spacing: 0; }
.transcript-markdown :where(th, td) { padding: 0.25em 0.6em; border: 1px solid rgb(127 127 127 / 24%); text-align: start; }
.transcript-table-actions { position: relative; margin-block-start: 4px; text-align: end; }
.transcript-table-actions summary { display: inline-block; cursor: pointer; padding: 5px 8px; border-radius: 4px; font-size: 12px; }
.transcript-table-actions summary:is(:hover, :focus-visible) { background: rgb(127 127 127 / 20%); }
.transcript-table-menu {
  display: grid; position: absolute; inset-inline-end: 0; inset-block-end: 100%; z-index: 2;
  min-width: 156px; padding: 4px; text-align: start; border-radius: 8px;
  border: 1px solid rgb(127 127 127 / 32%); background: #fff;
}
.dark .transcript-table-menu { background: #171717; }
.transcript-table-menu button { min-height: 32px; padding: 4px 8px; text-align: start; font-size: 12px; border-radius: 4px; }
.transcript-table-menu button:is(:hover, :focus-visible) { background: rgb(127 127 127 / 20%); }
.transcript-markdown :not(pre) > code { padding: 0.1em 0.32em; border-radius: 4px; background: rgb(127 127 127 / 13%); }
.transcript-code { border: 1px solid rgb(127 127 127 / 27%); border-radius: 8px; overflow: hidden; }
.transcript-code-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 3px 8px 3px 11px; font-size: 12px; background: rgb(127 127 127 / 10%);
}
.transcript-code-bar button { min-height: 32px; padding-inline: 8px; border-radius: 4px; }
.transcript-code-bar button:is(:hover, :focus-visible) { background: rgb(127 127 127 / 20%); }
.transcript-code-actions { display: flex; flex-wrap: wrap; gap: 2px; justify-content: flex-end; }
.transcript-code-bar button[aria-pressed="true"] { background: rgb(127 127 127 / 12%); }
.transcript-code pre { overflow: auto; padding: 9px 11px; white-space: pre; tab-size: 2; }
.transcript-code[data-wrap="true"] pre { white-space: pre-wrap; overflow-wrap: anywhere; }
[data-transcript-find] { z-index: 5; inset-inline-end: 12px; inset-block-start: 8px; width: min(330px, calc(100% - 24px)); }
[data-transcript-find] button:disabled { opacity: .4; }
[data-find-current] { outline: 2px solid #d89016; outline-offset: 2px; border-radius: 4px; }
::highlight(harness-find-result) { color: #261601; background: #f9dc89; }
::highlight(harness-find-current) { color: #1f1308; background: #f1a84f; }

`

const syntaxColors = { getCSS: () => `
.transcript-code code::highlight(harness-syntax-comment) { color: #585e69; }
.transcript-code code::highlight(harness-syntax-keyword) { color: #7d3077; }
.transcript-code code::highlight(harness-syntax-name) { color: #25518c; }
.transcript-code code::highlight(harness-syntax-string) { color: #276248; }
.transcript-code code::highlight(harness-syntax-value) { color: #854514; }
.dark .transcript-code code::highlight(harness-syntax-comment) { color: #a3aab5; }
.dark .transcript-code code::highlight(harness-syntax-keyword) { color: #e2a0de; }
.dark .transcript-code code::highlight(harness-syntax-name) { color: #a2c5f9; }
.dark .transcript-code code::highlight(harness-syntax-string) { color: #9fddba; }
.dark .transcript-code code::highlight(harness-syntax-value) { color: #e9b78d; }
` }

const approvalLayout = { getCSS: () => `
[data-approval] {
  width: min(788px, calc(100% - 24px));
  margin-inline: auto;
  margin-block: 4px 8px;
}
` }

const RESPONSIVE_SHELL = `
[data-harness-shell] {
  --workspace-bg: #fafaf9;
  --workspace-surface: #fff;
  --workspace-navigation: #f3f4f5;
  --workspace-line: rgb(26 32 44 / 12%);
  --workspace-hover: rgb(26 32 44 / 7%);
  --workspace-accent: #48679a;
  --workspace-added-text: #196840;
  --workspace-removed-text: #a02a32;
  --workspace-content: 42rem;
  --workspace-gutter: clamp(12px, 2.3vw, 36px);
  background: var(--workspace-bg);
}
.dark [data-harness-shell] {
  --workspace-bg: #121316;
  --workspace-surface: #1b1d22;
  --workspace-navigation: #17191e;
  --workspace-line: rgb(235 239 252 / 14%);
  --workspace-hover: rgb(235 239 252 / 9%);
  --workspace-accent: #a7bee8;
  --workspace-added-text: #7ad6a3;
  --workspace-removed-text: #ff9a9d;
}
.harness-icon-button {
  display: inline-grid; place-items: center; width: 30px; height: 30px;
  flex: 0 0 30px; border-radius: 7px;
}
.harness-icon-button:hover, .harness-icon-button[aria-expanded="true"],
[data-thread-search-option]:hover, [data-thread-search-option][aria-selected="true"] {
  background: var(--workspace-hover);
}
[data-harness-shell] :is(button, select, textarea, a):focus-visible {
  outline: 2px solid var(--workspace-accent); outline-offset: 2px;
}
[data-harness-sidebar] {
  display: flex; flex-direction: column; width: var(--harness-sidebar-width, 250px);
  background: var(--workspace-navigation);
  border-inline-end: 1px solid var(--workspace-line);
}
[data-navigation-chrome], [data-navigation-footer] { flex-shrink: 0; }
[data-navigation-footer] { display: flex; padding: 6px 8px max(6px, env(safe-area-inset-bottom)); border-block-start: 1px solid var(--workspace-line); }
[data-navigation-undo] { flex: 1; min-width: 0; }
[data-navigation-undo]:has([data-thread-undo][hidden]) { display: none; }
[data-navigation-footer]:has([data-navigation-undo]:not([hidden]) [data-thread-undo]:not([hidden])) [data-nav-settings] { flex: 0 0 auto; }
[data-navigation-footer]:has([data-navigation-undo]:not([hidden]) [data-thread-undo]:not([hidden])) [data-nav-settings] span:last-child { display: none; }
[data-navigation-undo] [data-thread-undo]:not([hidden]) { min-height: 30px; padding: 0 0 0 4px; background: transparent; border: 0; }
[data-navigation-undo] [data-thread-undo] button { min-height: 30px; }
[data-compact-thread-undo] { display: none; }
[data-thread-undo]:not([hidden]) {
  min-height: 38px; padding: 2px 10px;
  background: var(--workspace-surface); border-block-start: 1px solid var(--workspace-line);
}
[data-thread-undo] button { color: var(--workspace-accent); }
[data-navigation-content] { position: relative; flex: 1; min-height: 0; overflow: hidden; isolation: isolate; }
[data-harness-shell] [data-navigation-content] [data-stx-sidebar][data-sidebar-spaces="true"] {
  width: 100% !important;
  background: transparent !important;
  color: inherit;
}
[data-navigation-content] .stx-sidebar-rim { display: none; }
/* The installed SidebarSpace needs a zero flex minimum to keep its list scrollable. */
[data-navigation-content] [data-space] { min-height: 0; }
[data-brand-bar] [data-sidebar-close] { order: -1; }
[data-navigation-content] [data-sidebar-item] { min-height: 29px; }
[data-navigation-content] [data-sidebar-item][hidden] { display: none; }
[data-saved-drafts] { padding: 3px 6px 6px; margin-block-end: 4px; border-block-end: 1px solid var(--workspace-line); }
[data-navigation-content] [data-saved-draft-link] { grid-template-columns: minmax(0, 1fr); padding-inline: 8px 40px; background: color-mix(in srgb, var(--workspace-accent) 8%, transparent); }
[data-saved-draft-link]:hover, [data-saved-draft-link][aria-current="page"] { background: color-mix(in srgb, var(--workspace-accent) 16%, transparent); }
[data-saved-draft-link]:focus-visible { outline: 2px solid var(--workspace-accent); outline-offset: -2px; }
[data-sidebar-jump]::after, [data-model-jump] {
  flex: none; padding: 0 4px; border: 1px solid var(--workspace-line); border-radius: 4px;
  background: var(--workspace-surface); font: 11px/16px ui-monospace, monospace; white-space: nowrap;
}
[data-sidebar-jump]::after { content: attr(data-sidebar-jump); margin-inline-start: auto; }
[data-navigation-content] [data-saved-draft-link][data-sidebar-jump] { grid-template-columns: minmax(0, 1fr) auto; }
[data-saved-draft-link][data-sidebar-jump]::after { grid-area: 1 / 2; align-self: start; }
[data-saved-draft-title] { grid-column: 1 / -1; }
[data-sidebar-row]:has(> [data-draft-discard-row]) { position: relative; }
[data-sidebar-row]:has(> [data-draft-discard-row]) > [data-sidebar-item] { padding-inline-end: 40px; }
[data-sidebar-row] > [data-draft-discard-row], [data-saved-draft] > [data-draft-discard-row] {
  position: absolute; inset-inline-end: 4px; inset-block-start: 50%; translate: 0 -50%;
  width: 26px; height: 26px; color: var(--workspace-accent);
}
[data-navigation-content] [data-sidebar-row][data-collapsed] { visibility: hidden; }
[data-navigation-content] [data-sidebar-section]:not(:has([data-sidebar-row])) { display: none; }
[data-shelf-dragging] :is([data-section-id^="pinned-"], [data-section-id^="settled-"]):not(:has([data-sidebar-row])),
[data-projectless-drop] [data-section-id^="projectless-"]:not(:has([data-sidebar-row])) { display: block; }
[data-thread-order-ready] [data-thread-active-section] a[data-sidebar-item] { cursor: grab; }
[data-thread-order-ready] [data-section-id^="working-"] a[data-sidebar-item] { cursor: pointer; }
[data-pin-dragging] a[data-sidebar-item] { opacity: .52; cursor: grabbing; }
[data-pin-insertion] { position: relative; }
[data-pin-insertion]::after {
  content: ''; position: absolute; inset-inline: 4px; height: 2px; z-index: 1;
  background: var(--workspace-accent); border-radius: 2px; pointer-events: none;
}
[data-pin-insertion="before"]::after { top: 0; }
[data-pin-insertion="after"]::after { bottom: 0; }
[data-shelf-action]::before {
  content: attr(data-shelf-action); position: absolute; inset-inline-end: 6px; inset-block-start: 50%;
  transform: translateY(-50%); z-index: 2; pointer-events: none; padding: 1px 6px;
  color: var(--workspace-accent); background: var(--workspace-surface);
  border: 1px solid currentColor; border-radius: 5px; font-size: 11px; font-weight: 600; line-height: 18px;
}
[data-thread-arrangement] {
  width: min(34rem, calc(100% - 24px)); height: min(44rem, calc(100dvh - 24px));
  max-width: none; max-height: none; padding: 0; overflow: hidden;
  color: inherit; background: var(--workspace-surface); border: 1px solid var(--workspace-line); border-radius: 12px;
}
[data-thread-arrangement][open] { display: flex; flex-direction: column; }
[data-thread-arrangement]::backdrop { background: rgb(0 0 0 / 42%); }
[data-arrangement-chrome] {
  flex-shrink: 0; padding: max(8px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 12px max(16px, env(safe-area-inset-left));
  border-bottom: 1px solid var(--workspace-line);
}
[data-arrangement-done] { color: var(--workspace-accent); }
[data-arrangement-undo] { flex-shrink: 0; padding-block-end: env(safe-area-inset-bottom); }
[data-arrangement-undo]:has([data-thread-undo][hidden]) { display: none; }
[data-arrangement-scroll] {
  flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding: 4px max(16px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
}
[data-arrangement-section] + [data-arrangement-section] { border-top: 1px solid var(--workspace-line); }
[data-arrangement-header] {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; min-height: 44px; text-align: start; font-size: 13px; font-weight: 650;
}
[data-arrangement-header][aria-expanded='true'] span:last-child { transform: rotate(180deg); }
[data-arrangement-row] { min-height: 48px; border-top: 1px solid var(--workspace-line); }
[data-arrangement-row][data-pin-dragging] { opacity: .5; }
[data-arrangement-grip] {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 44px; height: 48px; touch-action: none; cursor: grab; user-select: none;
}
[data-arrangement-grip]:disabled { opacity: .5; cursor: default; }
[data-arrangement-preview] {
  position: fixed; z-index: 2; left: 50%; top: 0; width: min(30rem, calc(100% - 32px));
  transform: translate(-50%, clamp(2px, calc(var(--arrangement-preview-y) - 55px), calc(100dvh - 58px)));
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 9px 12px; pointer-events: none; background: var(--workspace-surface); color: var(--workspace-accent);
  border: 1px solid var(--workspace-accent); border-radius: 8px;
}
@media (max-width: 767px) {
  [data-thread-arrangement] { position: fixed; inset: 0; margin: 0; width: 100%; height: 100dvh; border: 0; border-radius: 0; }
}
@media (prefers-reduced-motion: reduce) {
  [data-navigation-content] :is([data-sidebar-row], [data-sidebar-item], [data-sidebar-section-chevron]) { transition: none; }
}
[data-navigation-content] [data-section-id^="project-"] [data-sidebar-section-header] {
  min-height: 29px; color: inherit; font-size: 12px; font-weight: 620;
}
[data-navigation-content] [data-item-id^="compose-"] { color: var(--workspace-accent); }
[data-navigation-content] [data-sidebar-item][data-active="true"] {
  background: color-mix(in srgb, var(--workspace-accent) 13%, var(--workspace-surface));
  box-shadow: inset 2px 0 var(--workspace-accent);
}
.harness-nav-search {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
  min-height: 30px; padding-inline: 8px; border-radius: 7px; text-align: start;
  font-size: 13px;
}
.harness-nav-search:hover { background: var(--workspace-hover); }
[data-sidebar-resize] {
  z-index: 1; flex: 0 0 6px; margin-inline: -3px;
  cursor: col-resize; touch-action: none;
}
[data-sidebar-resize]:hover, [data-sidebar-resize]:focus-visible { background: var(--workspace-hover); }
[data-sidebar-toggle], [data-sidebar-scrim], [data-workspace-actions-scrim],
[data-header-settings], [data-thread-search-toggle] { display: none; }
[data-harness-shell][data-sidebar-collapsed="true"] :is([data-harness-sidebar], [data-sidebar-resize]) { display: none; }
[data-harness-shell][data-sidebar-collapsed="true"] :is([data-sidebar-toggle], [data-header-settings], [data-thread-search-toggle]) {
  display: inline-grid; place-items: center;
}
[data-workspace-layout] {
  --workspace-header-height: 46px;
  display: grid; grid-template: var(--workspace-header-height) minmax(0, 1fr) / minmax(0, 1fr);
}
[data-harness-shell][data-sidebar-collapsed="true"] [data-workspace-layout]:has([data-compact-thread-undo]:not([hidden]) [data-thread-undo]:not([hidden])) {
  grid-template-rows: var(--workspace-header-height) auto minmax(0, 1fr);
}
[data-harness-shell][data-sidebar-collapsed="true"] [data-compact-thread-undo]:not([hidden]):has([data-thread-undo]:not([hidden])) { display: block; }
[data-compact-thread-undo] [data-thread-undo]:not([hidden]) { border-block-start: 0; border-block-end: 1px solid var(--workspace-line); }
[data-workspace-header] { border-block-end: 1px solid var(--workspace-line); }
[data-workspace-heading] { display: flex; gap: 8px; align-items: center; flex: 1 1 auto; }
[data-workspace-project] { max-width: min(36%, 24ch); }
[data-workspace-folder] { color: var(--workspace-accent); }
[data-session-state][data-state="idle"], [data-session-driver] { display: none; }
[data-session-state][data-state="running"] { color: var(--workspace-accent); background: var(--workspace-hover); }
[data-header-actions] { display: flex; gap: 4px; align-items: center; flex: 0 0 auto; }
[data-workspace-content] { display: flex; position: relative; min-height: 0; min-width: 0; }
[data-workspace-lane] { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
[data-workspace-draft] { justify-content: safe center; overflow-y: auto; padding-block: 12px; }
[data-workspace-draft]:has([data-composer]) { padding-block-end: min(16dvh, 128px); }
[data-workspace-draft] [data-transcript-viewport] { flex: none; }
[data-workspace-draft] [data-transcript] { height: auto; padding-block: 0 12px; }
[data-workspace-draft] [data-empty-state] { height: auto; }
[data-draft-title] {
  max-inline-size: min(32ch, 100%); color: inherit;
  font-size: clamp(21px, 2.15vw, 30px); font-weight: 620;
  letter-spacing: -.035em; line-height: 1.18; overflow-wrap: anywhere; text-wrap: balance;
}
[data-draft-context] {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 8px;
  width: min(var(--workspace-content), calc(100% - 2 * var(--workspace-gutter)));
  margin-inline: auto; padding-inline: 10px;
}
[data-draft-worktree] { min-width: 0; }
[data-draft-worktree] summary { min-height: 32px; align-content: center; }
[data-draft-worktree][open] > div {
  padding: 8px; border: 1px solid var(--workspace-line); border-radius: 8px;
  background: var(--workspace-surface);
}
@media (max-width: 640px) {
  [data-draft-worktree] summary, [data-draft-worktree] input:not([type="checkbox"]),
  [data-draft-worktree] select, [data-draft-worktree] fieldset label { min-height: 44px; }
}
[data-transcript] { padding-inline: var(--workspace-gutter); padding-block: var(--harness-transcript-top, 24px) 16px; }
[data-transcript]:focus-visible { outline: 2px solid var(--workspace-accent); outline-offset: -2px; }
[data-transcript] > :is([data-turn], [data-follow-ups]) { max-width: var(--workspace-content); margin-inline: auto; }
[data-jump-to-latest] { flex: none; align-self: center; min-height: 32px; margin-block: 4px; }
[data-jump-to-latest]:hover { background: var(--workspace-hover); }
@media (pointer: coarse) { [data-jump-to-latest] { min-height: 44px; } }
[data-user-prompt] { background: var(--workspace-hover); }
[data-user-prompt]:has(+ [data-prompt-share], + div > [data-prompt-share]) { margin-block-end: 2px; }
[data-prompt-share] { display: flex; justify-content: flex-end; gap: 2px; margin-block-end: 4px; }
[data-prompt-share] button { width: 30px; height: 28px; }
[data-linked-turn] { outline: 1px solid var(--workspace-accent); outline-offset: 3px; border-radius: 8px; }
[data-unavailable-message], [data-linked-prompt-notice] { margin: 4px auto; padding: 5px 8px; max-width: 100%; font-size: 13px; }
[data-linked-prompt-notice] { display: flex; align-items: center; gap: 6px; border: 1px solid var(--workspace-line); border-radius: 6px; }
[data-linked-prompt-notice] button { flex: none; }
[data-share-commands] { display: grid; gap: 2px; margin-block-start: 6px; }
[data-share-commands] button { min-height: 34px; border-radius: 6px; padding: 4px 8px; font-size: 13px; text-align: start; }
[data-share-commands] button:hover, [data-share-dialog-actions] button:hover { background: var(--workspace-hover); }
[data-prompt-link-dialog], [data-share-clipboard-dialog], [data-repository-commit-dialog], [data-repository-sync-dialog], [data-repository-pull-request-dialog] {
  width: min(430px, calc(100% - 24px)); max-height: calc(100dvh - 24px); margin: auto;
  padding: 0; color: inherit; background: var(--workspace-surface); border: 1px solid var(--workspace-line); border-radius: 12px;
}
[data-prompt-link-dialog]::backdrop, [data-share-clipboard-dialog]::backdrop, [data-repository-commit-dialog]::backdrop, [data-repository-sync-dialog]::backdrop, [data-repository-pull-request-dialog]::backdrop { background: rgb(0 0 0 / 45%); }
[data-share-dialog-body] { display: grid; gap: 10px; padding: 16px; font-size: 13px; overflow-wrap: anywhere; }
[data-share-dialog-body] h2 { font-size: 16px; font-weight: 600; }
[data-share-dialog-body] pre, [data-share-dialog-body] textarea {
  width: 100%; max-height: min(240px, 35dvh); padding: 8px; overflow-y: auto; white-space: pre-wrap;
  overflow-wrap: anywhere; font: inherit; background: var(--workspace-hover); border-radius: 6px;
}
[data-repository-pull-request-dialog] input:not([type="checkbox"]) {
  background: var(--workspace-hover); color: inherit;
}
.dark [data-repository-pull-request-dialog] { color-scheme: dark; }
[data-share-dialog-body] [role="alert"] { color: var(--workspace-error, #a93939); }
.dark [data-share-dialog-body] [role="alert"] { color: #ffaba7; }
[data-share-dialog-body] a { text-decoration: underline; min-height: 34px; align-content: center; }
[data-share-dialog-actions] { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
[data-share-dialog-actions] button { min-height: 36px; padding: 4px 8px; border: 1px solid var(--workspace-line); border-radius: 6px; }
[data-share-dialog-actions] [data-share-primary] { font-weight: 600; background: var(--workspace-hover); }
[data-share-dialog-actions] :is([data-pull-request-confirm], [data-repository-sync-confirm], [data-repository-pull-request-confirm]) { background: var(--workspace-accent); border-color: var(--workspace-accent); color: white; }
.dark [data-share-dialog-actions] :is([data-pull-request-confirm], [data-repository-sync-confirm], [data-repository-pull-request-confirm]) { color: #101318; }
[data-share-dialog-actions] :is([data-pull-request-confirm], [data-repository-sync-confirm], [data-repository-pull-request-confirm]):hover:not(:disabled) { filter: brightness(1.08); }
@media (pointer: coarse) {
  [data-prompt-share] button, [data-share-dialog-actions] button, [data-share-commands] button { min-height: 44px; min-width: 44px; }
}
.harness-response-action:not([hidden]) {
  display: inline-flex; align-items: center; gap: 4px; min-height: 32px;
  margin-block-start: 6px; padding-inline: 7px; border-radius: 6px; font-size: 12px;
}
.harness-response-action:hover { background: var(--workspace-hover); }
.harness-response-action:disabled { opacity: .55; }
[data-turn-file-summary] { margin-block: .5rem; max-width: 35rem; min-width: 0; font-size: .75rem; border: 1px solid var(--workspace-line); border-radius: .5rem; }
[data-turn-file-summary] > summary { cursor: pointer; padding: .375rem .625rem; line-height: 1.25rem; font-weight: 500; }
[data-turn-file-repository] { padding: 0 .25rem .25rem; }
[data-turn-file-repository] > p { margin: .125rem .375rem; opacity: .75; overflow-wrap: anywhere; }
[data-turn-file] { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: .375rem; align-items: center; width: 100%; min-height: 1.75rem; padding: .125rem .375rem; text-align: start; border-radius: .25rem; }
[data-turn-file]:hover, [data-turn-file-summary] > summary:hover { background: var(--workspace-hover); }
[data-turn-file-insertions], [data-turn-file-deletions] { font-variant-numeric: tabular-nums; }
[data-turn-file-insertions] { color: var(--workspace-added-text); }
[data-turn-file-deletions] { color: var(--workspace-removed-text); }
@media (pointer: coarse) { [data-turn-file], [data-turn-file-summary] > summary { min-height: 44px; } }
[data-fork-banner] { max-width: var(--workspace-content); justify-content: center; border-top: 1px solid var(--workspace-line); }
@media (pointer: coarse) { .harness-response-action:not([hidden]) { min-height: 44px; } }
[data-session-error] { width: min(var(--workspace-content), calc(100% - 2 * var(--workspace-gutter))); }
[data-composer] {
  position: relative; box-sizing: border-box;
  grid-template-columns: minmax(0, 1fr);
  width: min(var(--workspace-content), calc(100% - 2 * var(--workspace-gutter)));
  margin: 4px auto max(16px, env(safe-area-inset-bottom));
  padding: 10px 11px;
  background: var(--workspace-surface);
  border: 1px solid var(--workspace-line); border-radius: 15px;
}
[data-composer]:focus-within { border-color: color-mix(in srgb, var(--workspace-accent) 60%, var(--workspace-line)); }
[data-workspace-draft] [data-composer] { margin-block-end: 4px; }
[data-background-thread], [data-model-batch] {
  position: absolute; z-index: 6; inset-block-start: 12px; inset-inline-end: var(--workspace-gutter);
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
  max-inline-size: calc(100% - 2 * var(--workspace-gutter)); padding: 4px 6px 4px 12px;
  color: inherit; font-size: 13px; background: var(--workspace-surface);
  border: 1px solid var(--workspace-line); border-radius: 9px; box-shadow: 0 6px 18px rgb(0 0 0 / 12%);
}
[data-model-batch] { display: grid; max-inline-size: min(24rem, calc(100% - 2 * var(--workspace-gutter))); max-block-size: 45%; overflow: auto; overflow-wrap: anywhere; }
[data-model-batch] a, [data-model-batch] button:not(.harness-icon-button) { color: var(--workspace-accent); text-decoration: underline; }
[data-background-thread] a { color: var(--workspace-accent); text-decoration: underline; white-space: nowrap; }
[data-prompt]::placeholder { color: #656a71; opacity: 1; }
.dark [data-prompt]::placeholder { color: #a2a6b0; }
[data-prompt]:focus-visible { outline: none !important; }
[data-composer-file-menu] {
  position: absolute; z-index: 5; inset-inline: 12px; inset-block-end: calc(100% + 4px);
  max-block-size: min(280px, 36dvh); padding: 4px; overflow: auto; overscroll-behavior: contain;
  background: var(--workspace-surface); border: 1px solid var(--workspace-line); border-radius: 10px;
  box-shadow: 0 6px 18px rgb(0 0 0 / 12%);
}
.harness-composer-file-option {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) minmax(0, auto);
  align-items: center; gap: 7px; width: 100%; min-height: 32px;
  padding-inline: 7px; text-align: start; font-size: 13px; border-radius: 6px;
}
.harness-composer-file-option > :last-child { max-width: 34vw; }
.harness-composer-file-option:is(:hover, [aria-selected='true']) { background: var(--workspace-hover); }
@media (pointer: coarse), (max-width: 47.999rem) {
  .harness-composer-file-option { min-height: 44px; }
}
[data-composer-toolbar] { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
[data-composer-provider-controls] { display: flex; min-width: 0; align-items: center; }
[data-composer-provider-controls] select { max-width: min(230px, 100%); }
[data-composer-actions] { flex-shrink: 0; align-items: center; }
[data-idle-compaction][aria-pressed="true"], [data-idle-compaction]:hover { background: var(--workspace-hover); }
[data-send] {
  padding-inline: 12px; font-weight: 600; color: var(--workspace-surface);
  background: var(--workspace-accent);
}
[data-send]:hover:not(:disabled) { background: color-mix(in srgb, var(--workspace-accent) 87%, currentColor); }
[data-send][data-primary-send="true"]:not([hidden]) {
  display: inline-grid; place-items: center; padding: 0; inline-size: 32px;
}
[data-send-icon] { display: none; }
[data-send][data-primary-send="true"] [data-send-icon] { display: block; }
[data-send][data-primary-send="true"] [data-send-text] {
  position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%);
}
[data-send]:disabled { background: var(--workspace-hover); color: inherit; cursor: default; }
[data-model-picker-trigger] { color: inherit; }
[data-model-picker-trigger]:hover, [data-model-picker-trigger][aria-expanded="true"] { background: var(--workspace-hover); }
[data-draft-model-dialog] {
  --draft-picker-width: min(37rem, calc(100vw - 16px), var(--draft-picker-available-width, 37rem));
  position: fixed; inset: auto; top: var(--draft-picker-top, 8px);
  left: clamp(8px, var(--draft-picker-left, 8px), calc(100vw - var(--draft-picker-width) - 8px));
  width: var(--draft-picker-width); height: min(23rem, calc(var(--draft-picker-viewport, 100dvh) - 16px));
  max-width: none; max-height: none; padding: 0; margin: 0; overflow: hidden;
  color: inherit; background: var(--workspace-surface); border: 1px solid var(--workspace-line);
  border-radius: 12px; box-shadow: 0 15px 45px rgb(11 18 33 / 23%); font-size: 13px;
}
[data-draft-model-dialog]::backdrop { background: transparent; }
[data-draft-model-dialog] [hidden] { display: none; }
[data-draft-model-layout] {
  display: grid; grid-template-columns: 10.25rem minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto; height: 100%;
}
[data-draft-model-layout]:has([data-draft-model-options]:not([hidden])) { grid-template-columns: 10.25rem minmax(0, 1fr) 9.75rem; }
[data-draft-model-accounts], [data-draft-model-options] { min-width: 0; overflow: auto; padding: 8px; }
[data-draft-model-accounts] { border-inline-end: 1px solid var(--workspace-line); }
[data-draft-model-options] { border-inline-start: 1px solid var(--workspace-line); }
[data-draft-model-layout] h2 { margin: 3px 5px 8px; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
[data-draft-model-main] { display: flex; flex-direction: column; gap: 6px; min-height: 0; min-width: 0; padding: 8px; }
[data-draft-model-main] input { width: 100%; min-height: 35px; padding: 6px 8px; background: var(--workspace-bg); border: 1px solid var(--workspace-line); border-radius: 6px; }
[data-draft-model-main] [role="grid"] { min-height: 0; overflow: auto; }
[data-draft-model-main] [role="status"], [data-draft-model-main] [role="alert"] { margin: 3px 7px; opacity: .8; }
[data-draft-model-layout] button {
  width: 100%; min-height: 30px; padding: 4px 7px; border-radius: 6px;
  display: flex; align-items: center; gap: 5px; text-align: start;
}
[data-draft-model-account] { flex-direction: column; align-items: flex-start !important; }
[data-draft-model-account] span { max-width: 100%; }
[data-draft-model-layout] small { font-size: 11px; opacity: .78; }
[data-draft-model-row] { display: flex; }
[data-draft-model-row] > [role="gridcell"]:first-child { flex: 1; min-width: 0; }
[data-draft-model-option] > span:first-child { flex: 1 1 auto; min-width: 0; }
[data-draft-model-option] > small { max-width: 45%; }
[data-draft-model-star], [data-compare-model] { min-width: 32px; justify-content: center; opacity: .75; }
[data-compare-model][aria-pressed="true"] { color: var(--workspace-accent); }
[data-model-picker-count] { display: none; white-space: nowrap; }
[data-draft-model-star][aria-pressed="true"] { color: var(--workspace-accent); opacity: 1; }
[data-draft-model-layout] button[aria-pressed="true"], [data-draft-model-layout] button[data-highlighted="true"], [data-draft-model-layout] button:hover:not(:disabled) { background: var(--workspace-hover); }
[data-draft-model-layout] button:disabled { opacity: .68; cursor: default; }
[data-draft-model-layout] :focus-visible { outline: 2px solid var(--workspace-accent); outline-offset: -2px; }
[data-draft-model-options] fieldset { margin: 0 0 8px; }
[data-draft-model-options] legend { padding: 0 5px 4px; font-size: 11px; opacity: .8; }
[data-draft-model-footer] { grid-column: 1 / -1; display: flex; align-items: center; justify-content: flex-end; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--workspace-line); }
[data-draft-model-new-thread] { flex-shrink: 0; font-size: 12px; }
[data-draft-model-footer] [data-driver-picker] { margin-inline-end: auto; max-inline-size: calc(100% - 64px); }
[data-draft-model-footer] button { width: auto; min-width: 55px; justify-content: center; border: 1px solid var(--workspace-line); }
@media (max-width: 600px) {
  [data-model-picker-trigger][data-comparing-models="true"] [data-model-picker-label] { display: none; }
  [data-model-picker-trigger][data-comparing-models="true"] [data-model-picker-count] { display: inline; }
  [data-draft-model-dialog] { height: min(29rem, calc(var(--draft-picker-viewport, 100dvh) - 16px)); }
  [data-draft-model-layout], [data-draft-model-layout]:has([data-draft-model-options]:not([hidden])) {
    grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto auto;
  }
  [data-draft-model-accounts] { display: flex; align-items: center; overflow-x: auto; gap: 4px; border-inline-end: 0; border-bottom: 1px solid var(--workspace-line); }
  [data-draft-model-accounts] h2 { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
  [data-draft-model-accounts] button { flex: 0 0 auto; width: auto; max-width: 10rem; }
  [data-draft-model-options] { max-height: min(11rem, 35dvh); border-inline-start: 0; border-top: 1px solid var(--workspace-line); }
  [data-draft-model-options]:not([hidden]) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
  [data-draft-model-options] h2 { grid-column: 1 / -1; }
}
@media (pointer: coarse) {
  [data-draft-model-layout] button, [data-draft-model-main] input { min-height: 44px; }
  [data-compare-model] { min-width: 44px; }
}
[data-workspace-rail] {
  position: absolute; inset-block-start: 5px; inset-inline-end: var(--workspace-gutter);
  z-index: 45; width: min(21rem, calc(100% - 2 * var(--workspace-gutter)));
  max-height: calc(100% - 14px); overflow: auto; pointer-events: none;
}
[data-workspace-actions], [data-diff], [data-files], [data-browser-pane] {
  background: var(--workspace-surface); border: 1px solid var(--workspace-line);
  border-radius: 12px; pointer-events: auto; min-width: 0;
}
[data-workspace-actions] { display: none; flex-direction: column; padding: 5px; gap: 2px; }
[data-workspace-actions][data-open="true"] { display: flex; }
[data-workspace-context] {
  display: flex; align-items: center; gap: 9px; padding: 8px;
  min-width: 0; font-weight: 600; font-size: 13px; border-bottom: 1px solid var(--workspace-line);
}
[data-workspace-actions] > button {
  display: flex; align-items: center; justify-content: flex-start; gap: 9px;
  min-height: 34px; width: 100%; padding-inline: 8px; border: 0;
  font-size: 13px; text-align: start; white-space: nowrap;
}
[data-workspace-actions] > button:hover, [data-workspace-actions] > button[aria-expanded="true"] {
  background: var(--workspace-hover); border-radius: 6px;
}
[data-workspace-actions-scrim]:not([hidden]) { display: block; position: fixed; inset: 0; z-index: 44; }
[data-workspace-actions-toggle] { position: relative; z-index: 46; }
[data-diff]:not([hidden]) { display: flex; flex-direction: column; min-block-size: 0; }
[data-diff] { --diff-addition: #e7f5ee; --diff-deletion: #fbe9e9; }
.dark [data-diff] { --diff-addition: #183529; --diff-deletion: #40252b; }
[data-diff-header] { padding: 5px 8px 5px 12px; border-block-end: 1px solid var(--workspace-line); }
[data-diff-body] { flex: 1; min-block-size: 0; overflow: auto; }
[data-diff-layout-controls] { display: inline-flex; border: 1px solid var(--workspace-line); border-radius: 6px; padding: 2px; }
[data-diff-layout-controls] button, [data-diff-wrap-control] {
  padding-inline: 8px; min-height: 26px; font-size: 12px; border-radius: 4px;
}
[data-diff-header] button[aria-pressed="true"], [data-diff-header] button:hover { background: var(--workspace-hover); }
[data-diff-comparison]:not([hidden]) {
  display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; padding: 6px 12px;
  border-block-end: 1px solid var(--workspace-line); font-size: 12px;
}
[data-diff-comparison] label:not([hidden]) { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
[data-diff-comparison] select {
  min-width: 0; max-width: min(16rem, 64vw); min-height: 28px; padding-inline: 6px;
  background: var(--workspace-surface); color: inherit; border: 1px solid var(--workspace-line); border-radius: 5px;
}
.dark [data-diff-comparison] select { color-scheme: dark; }
[data-diff-overview] {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px;
  padding: 7px 12px; border-block-end: 1px solid var(--workspace-line); font-size: 12px;
}
[data-diff-status] { margin: 0; opacity: .78; }
[data-diff-overview] button, [data-diff-more] { padding: 3px 6px; font-size: 12px; border-radius: 5px; }
[data-diff-overview] button[aria-disabled="true"] { opacity: .6; }
[data-diff-overview] button:hover, [data-diff-more]:hover { background: var(--workspace-hover); }
[data-diff-files] { margin: 0; padding: 0; }
[data-diff-file] { border-block-end: 1px solid var(--workspace-line); }
[data-diff-file-toggle] {
  display: flex; align-items: center; gap: 7px; width: 100%; min-height: 34px; min-width: 0;
  padding: 4px 10px; text-align: start; font-size: 12px;
}
[data-diff-file-toggle]:hover, [data-diff-file-toggle][aria-expanded="true"] { background: var(--workspace-hover); }
[data-diff-file-kind] { font-size: 11px; opacity: .8; flex-shrink: 0; }
[data-diff-lines] { overflow-x: auto; font: 12px/1.55 var(--font-mono, monospace); }
[data-diff-cell] {
  display: flex; min-width: 0; gap: 4px; padding-inline: 5px 7px;
  border-block-end: 1px solid transparent; tab-size: 4;
}
[data-diff-line-content] { min-width: 0; }
[data-diff-cell] code { font: inherit; white-space: pre; }
[data-diff][data-diff-wrap="true"] [data-diff-cell] code { white-space: pre-wrap; overflow-wrap: anywhere; }
[data-diff-line-number], [data-diff-mark] { flex-shrink: 0; color: inherit; opacity: .78; user-select: none; }
[data-diff-line-number] { align-self: flex-start; min-width: 3ch; text-align: end; border-radius: 3px; }
[data-diff-line-number]:enabled { cursor: pointer; }
[data-diff-line-number]:enabled:hover { background: var(--workspace-hover); opacity: 1; }
[data-diff-line-number][aria-pressed="true"] { background: var(--workspace-hover); opacity: 1; font-weight: 700; }
[data-diff-cell]:has([data-diff-line-number][aria-pressed="true"]:not([hidden])) { box-shadow: inset 0 -1px currentColor; }
[data-diff-line-number]:focus-visible, [data-diff-line-actions] button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
[data-diff-line-actions]:not([hidden]) {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 12px; font-size: 12px;
  border-block-start: 1px solid var(--workspace-line);
}
[data-diff-line-actions] p { margin: 0; }
[data-diff-line-actions] button { flex-shrink: 0; border: 1px solid var(--workspace-line); padding: 4px 8px; border-radius: 6px; }
[data-diff-line-actions] button:hover { background: var(--workspace-hover); }
[data-diff-file-heading] { display: flex; align-items: center; min-width: 0; }
[data-diff-file-heading] [data-diff-file-toggle] { flex: 1 1 0; min-width: 0; }
[data-diff-file-editor] { flex-shrink: 0; margin-inline-end: 2px; }
[data-workspace-editor] {
  box-sizing: border-box; margin: auto; padding: 0; overflow: auto;
  width: min(360px, calc(100% - 24px)); max-height: min(28rem, calc(100dvh - 28px));
  border: 1px solid var(--workspace-line); border-radius: 12px;
  background: var(--workspace-surface); color: inherit;
  box-shadow: 0 16px 56px rgb(0 0 0 / 24%);
}
@media (min-width: 48rem) {
  [data-workspace-editor][data-editor-edge] { inset: auto; left: var(--editor-inline); margin: 0; max-height: min(28rem, calc(100dvh - var(--editor-edge) - 12px)); }
  [data-workspace-editor][data-editor-edge="below"] { top: var(--editor-edge); }
  [data-workspace-editor][data-editor-edge="above"] { bottom: var(--editor-edge); }
}
[data-workspace-editor]::backdrop, #harness-project-scripts::backdrop { background: rgb(0 0 0 / 32%); }
#harness-project-scripts {
  box-sizing: border-box; margin: auto; padding: 0; overflow: auto;
  width: min(540px, calc(100% - 24px)); max-height: calc(100dvh - 28px);
  border: 1px solid var(--workspace-line); border-radius: 12px;
  background: var(--workspace-surface); color: inherit;
  box-shadow: 0 16px 56px rgb(0 0 0 / 24%);
}
[data-workspace-editor-choice] {
  display: flex; gap: 8px; align-items: center; width: 100%; min-height: 34px;
  text-align: start; border-radius: 6px; padding-inline: 7px; font-size: 13px;
}
[data-workspace-editor-choice]:hover { background: var(--workspace-hover); }
[data-workspace-editor-choice]:focus-visible { outline: 2px solid var(--workspace-accent); outline-offset: -2px; }
[data-workspace-editor-choice]:disabled { opacity: .55; }
[data-workspace-actions] [data-workspace-editor-menu] { display: none; }
[data-diff-mark] { width: 1ch; text-align: center; }
[data-diff-cell][data-kind="addition"] { background: var(--diff-addition); }
[data-diff-cell][data-kind="deletion"] { background: var(--diff-deletion); }
[data-diff-cell][data-kind="empty"] { background: var(--workspace-hover); }
[data-diff-newline-note]:not([hidden]) { display: block; font-size: 11px; font-style: italic; }
[data-diff-hunk], [data-diff-side-headings] { background: var(--workspace-hover); padding: 3px 8px; font-size: 11px; }
[data-diff-gap] { display: flex; align-items: center; gap: 3px; padding: 2px 4px; background: var(--workspace-hover); font-size: 11px; }
[data-diff-gap] button { display: inline-flex; align-items: center; min-height: 24px; padding-inline: 5px; border-radius: 4px; }
[data-diff-gap] button[hidden] { display: none; }
[data-diff-gap] button:hover { box-shadow: inset 0 0 0 1px var(--workspace-line); }
[data-diff-gap] button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
[data-diff-layout="split"] [data-diff-grid] { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
[data-diff-layout="split"] :is([data-diff-hunk], [data-diff-gap]) { grid-column: 1 / -1; }
[data-diff-layout="split"] :is([data-diff-row], [data-diff-side-headings]):not([hidden]) {
  display: grid; grid-column: 1 / -1; grid-template-columns: subgrid;
}
[data-diff-layout="split"] [data-diff-cell]:only-child { grid-column: 1 / -1; }
[data-diff-layout="split"] [data-diff-cell] + [data-diff-cell] { border-inline-start: 1px solid var(--workspace-line); }
[data-diff][data-diff-wrap="false"] [data-diff-grid] { min-width: 100%; width: max-content; }
[data-diff-layout="split"][data-diff-wrap="false"] [data-diff-grid] { grid-template-columns: repeat(2, minmax(30ch, 1fr)); }
[data-diff-raw], [data-diff-empty-patch], [data-diff-more] { margin: 8px 12px; font-size: 12px; }
[data-diff-raw] pre { overflow-x: auto; max-height: 18rem; }
@media (pointer: coarse) {
  [data-diff-header] button, [data-diff-file-toggle], [data-diff-more], [data-diff-overview] button { min-height: 44px; }
}
@media (pointer: coarse), (max-width: 47.999rem) {
  [data-diff-gap] button { min-height: 44px; }
  [data-diff-gap] button:has(span) { justify-content: center; min-width: 44px; }
  [data-diff-line-actions] button { min-height: 44px; }
  [data-diff-file-editor], [data-workspace-file-editor], [data-workspace-editor-choice] { min-height: 44px; }
  [data-diff-file-editor], [data-workspace-file-editor] { min-width: 44px; }
  [data-diff-comparison] label { position: relative; }
  [data-diff-comparison] label::after {
    content: ''; pointer-events: none; position: absolute; inset-inline-end: 11px; inset-block-start: calc(50% - 4px);
    inline-size: 6px; block-size: 6px; border-inline-end: 1px solid; border-block-end: 1px solid; transform: rotate(45deg);
  }
  [data-diff-comparison] select { appearance: none; min-height: 44px; padding-inline-end: 26px; font-size: 16px; }
}
[data-files]:not([hidden]) { display: flex; flex: 1; flex-direction: column; min-block-size: 0; overflow: hidden; }
[data-browser-pane]:not([hidden]) { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
[data-preview-tabs] { display: flex; gap: 3px; overflow-x: auto; }
[data-preview-tab] { display: flex; flex: 0 0 auto; gap: 2px; align-items: center; max-width: min(12rem, 100%); padding-inline-start: 6px; border: 1px solid transparent; border-radius: 7px; }
[data-preview-tab][data-active="true"] { border-color: var(--workspace-line); }
[data-preview-tab] > button:first-child { padding-block: 7px; text-align: start; font-size: 12px; }
[data-preview-address] { border-block: 1px solid var(--workspace-line); }
[data-preview-address] > input { min-height: 32px; appearance: none; background: transparent; color: inherit; border: 1px solid var(--workspace-line); font-size: 13px; }
[data-preview-address] .harness-icon-button:disabled, [data-browser-pane] header .harness-icon-button:disabled { opacity: .4; }
[data-preview-documents] iframe { display: block; width: 100%; height: 100%; border: none; background: white; }
[data-preview-documents] iframe[hidden], [data-preview-empty][hidden] { display: none; }
[data-preview-server] { min-height: 44px; border: 1px solid var(--workspace-line); }
[data-preview-server]:hover { background: var(--workspace-hover); }
@media (pointer: coarse) {
  [data-browser-pane] .harness-icon-button, [data-preview-address] > input { min-height: 44px; }
  [data-preview-address] > input { font-size: 16px; }
}
[data-workspace-files-header], [data-workspace-file-toolbar], [data-workspace-file-options] {
  border-block-end: 1px solid var(--workspace-line);
}
[data-workspace-files-body] { display: grid; flex: 1; min-block-size: 0; grid-template: minmax(0, 1fr) / minmax(0, 1fr); }
[data-workspace-files-tree], [data-workspace-file-detail]:not([hidden]) { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
[data-workspace-files-tree] input { min-height: 30px; }
[data-workspace-file-entries] { flex: 1; overflow: auto; margin: 0; padding: 0 4px 6px; }
[data-workspace-file-row] {
  display: flex; align-items: center; gap: 5px; min-height: 30px; width: 100%; min-width: 0;
  padding-inline: calc(6px + min(var(--workspace-file-depth, 0), 8) * 10px) 6px;
  border-radius: 5px; font-size: 12px; text-align: start;
}
[data-workspace-file-row]:hover, [data-workspace-file-row][data-selected="true"],
[data-workspace-file-options] button:hover, [data-workspace-file-options] button[aria-pressed="true"] { background: var(--workspace-hover); }
[data-workspace-file-toolbar], [data-workspace-file-options]:not([hidden]) { display: flex; align-items: center; gap: 4px; padding: 5px 8px; }
[data-workspace-file-options]:not([hidden]) { justify-content: space-between; flex-wrap: wrap; }
[data-workspace-file-options] :is(input, button) {
  border: 1px solid var(--workspace-line); border-radius: 5px; padding: 3px 6px;
  font-size: 12px; min-height: 28px; background-color: transparent;
}
[data-workspace-file-options] input { width: 5em; }
[data-workspace-source]:not([hidden]) { flex: 1; overflow: auto; }
[data-workspace-source-inner] { position: relative; display: flex; width: max-content; min-width: 100%; }
[data-workspace-source-inner] pre {
  position: relative; margin: 0; padding: 8px; font-size: 12px; line-height: 19px; tab-size: 4; white-space: pre;
}
[data-workspace-source-numbers] { text-align: end; opacity: .6; user-select: none; border-inline-end: 1px solid var(--workspace-line); }
[data-workspace-source][data-view-line]:not([data-view-line="0"]) [data-workspace-source-inner]::before {
  content: ''; position: absolute; inset-inline: 0; height: 19px;
  top: calc(8px + (var(--workspace-file-line) - 1) * 19px); background: var(--workspace-hover);
}
[data-workspace-file-frame], [data-workspace-file-image] { flex: 1; min-height: 0; width: 100%; border: 0; }
[data-workspace-file-frame][sandbox] { background-color: #fff; }
[data-workspace-file-image] { display: grid; place-items: start center; overflow: auto; padding: 12px; }
[data-workspace-file-image] img { max-width: 100%; height: auto; }
[data-workspace-file-notice] { border-block-start: 1px solid var(--workspace-line); }
@media (pointer: coarse) {
  [data-files] :is(.harness-icon-button, [data-workspace-file-row]), [data-workspace-file-options] :is(input, button) { min-height: 44px; }
}
[data-project-dialog]::backdrop, [data-project-clone-dialog]::backdrop, [data-settings-modal]::backdrop,
[data-thread-search]::backdrop, [data-prompt-stash]::backdrop, [data-sent-image-dialog]::backdrop { background: rgb(0 0 0 / 45%); }
[data-sent-image-dialog] { width: max-content; min-width: min(90vw, 360px); max-width: min(90vw, 980px); }
[data-sent-image-dialog] img { min-width: min(100%, 128px); }
#harness-thread-actions {
  position: fixed; inset: auto; top: var(--thread-menu-top, 44px); left: var(--thread-menu-left, 8px);
  width: min(14rem, calc(100% - 16px)); max-height: calc(100dvh - var(--thread-menu-top, 44px) - 8px);
}
#harness-thread-actions::backdrop { background: transparent; }
[data-thread-action]:not([hidden]) {
  display: flex; gap: 8px; align-items: center; width: 100%; min-height: 30px;
  padding-inline: 8px; text-align: start; border-radius: 4px; font-size: 13px;
}
[data-thread-action] > span { display: inline-block; width: 14px; height: 14px; flex-shrink: 0; opacity: .65; }
[data-thread-action] > :is([data-snooze-label], [data-snooze-detail]) { width: auto; height: auto; }
[data-thread-action] > [data-snooze-label] { flex: 1; opacity: 1; }
[data-thread-action] > [data-snooze-detail] { font-size: 11px; font-variant-numeric: tabular-nums; }
[data-snooze-arrow] { margin-inline-start: auto; }
#thread-snooze-form { padding-inline-start: 8px; }
#harness-thread-actions[data-snooze-side="true"] #thread-snooze-form {
  position: fixed; top: var(--thread-snooze-top); left: var(--thread-snooze-left);
  width: 200px; max-height: calc(100dvh - var(--thread-snooze-top) - 8px); overflow: auto;
  padding: 4px; background: var(--workspace-surface); border: 1px solid var(--workspace-line);
  border-radius: 8px; box-shadow: 0 6px 20px rgb(0 0 0 / 12%);
}
[data-thread-action]:hover:not(:disabled), [data-thread-action]:focus-visible {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
[data-thread-action]:disabled { opacity: .5; }
@media (pointer: coarse) {
  [data-thread-action]:not([hidden]), #harness-thread-actions form button { min-height: 44px; }
}
#harness-thread-actions [hidden] { display: none; }
[data-project-dialog], [data-project-clone-dialog] { width: min(480px, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); }
[data-settings-modal] {
  width: min(78rem, calc(100% - 4rem)); height: min(51rem, calc(100dvh - 4rem));
  max-height: none; border-radius: 14px; background: var(--workspace-bg);
}
[data-settings-modal]::backdrop { background: rgb(19 26 40 / 29%); backdrop-filter: blur(2px); }
[data-settings-shell] {
  display: grid; grid-template: auto minmax(0, 1fr) / 14rem minmax(0, 1fr);
  height: 100%;
}
[data-settings-header] { grid-area: 1 / 2; padding: 8px 12px 8px 16px; border-bottom: 1px solid var(--workspace-line); }
[data-settings-navigation] { background: var(--workspace-navigation); grid-area: 1 / 1 / 3 / 2; display: flex; flex-direction: column; gap: 4px; padding: 12px 8px; min-height: 0; overflow: auto; border-inline-end: 1px solid var(--workspace-line); }
[data-settings-navigation] button:not([hidden]) { display: flex; align-items: center; gap: 8px; min-height: 36px; padding-inline: 8px; text-align: start; font-size: 13px; border-radius: 6px; }
[data-settings-navigation] button:is(:hover, :focus-visible, [aria-current="page"]) { background: var(--workspace-hover); }
[data-settings-search] {
  inline-size: min(13rem, 36%); min-inline-size: 0; min-block-size: 32px;
  padding-inline: 8px; font-size: 12px; color: inherit;
  background: var(--workspace-surface); border: 1px solid var(--workspace-line); border-radius: 6px;
}
[data-settings-empty] { padding: 6px; font-size: 12px; overflow-wrap: anywhere; }
[data-settings-panel] { grid-area: 2 / 2; min-height: 0; overflow: auto; padding: 20px 24px; }
[data-settings-pane] { max-width: 42rem; margin-inline: auto; }
[data-settings-section] { width: fit-content; margin-block-end: 16px; font-size: 18px; font-weight: 650; outline-offset: 3px; }
[data-settings-panel] select { min-height: 34px; }
[data-settings-fields] { border: 1px solid var(--workspace-line); border-radius: 9px; background: var(--workspace-surface); }
[data-settings-field] {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px;
  padding: 10px 12px; font-size: 13px; font-weight: 500;
}
[data-settings-field] + [data-settings-field] { border-block-start: 1px solid var(--workspace-line); }
[data-settings-field] select { min-inline-size: min(13rem, 100%); max-inline-size: 100%; }
[data-snooze-row] { min-inline-size: 0; padding: 9px 12px; border-block-end: 1px solid var(--workspace-line); }
[data-snooze-row-controls] {
  display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, .65fr) minmax(0, .9fr) minmax(7.5rem, 1fr) auto;
  gap: 6px; align-items: end;
}
[data-snooze-row-controls] label { display: grid; gap: 3px; min-inline-size: 0; font-size: 12px; }
[data-snooze-row-controls] label[hidden] { display: none; }
[data-snooze-clock] { grid-column: span 2; }
[data-snooze-row-controls] input, [data-snooze-row-controls] select, [data-snooze-settings] button {
  min-inline-size: 0; min-block-size: 36px; padding-inline: 8px; border: 1px solid var(--workspace-line);
  border-radius: 6px; background: var(--workspace-surface); color: inherit; font-size: 13px;
}
[data-snooze-row-controls] input, [data-snooze-row-controls] select { inline-size: 100%; }
[data-snooze-select] { position: relative; }
[data-snooze-select] select { appearance: none; padding-inline-end: 23px; }
[data-snooze-select]::after {
  content: ''; position: absolute; inset-inline-end: 10px; inset-block-end: 16px;
  width: 6px; height: 6px; border-inline-end: 1px solid; border-block-end: 1px solid;
  transform: rotate(45deg); pointer-events: none;
}
[data-snooze-preview] { align-self: end; display: flex; align-items: center; min-block-size: 36px; }
[data-snooze-settings] button:not(:disabled):hover { background: var(--workspace-hover); }
[data-snooze-settings] button:disabled { opacity: .55; }
[data-snooze-remove] { display: grid; place-items: center; inline-size: 36px; padding-inline: 0; }
@media (pointer: coarse) {
  [data-snooze-row-controls] input, [data-snooze-row-controls] select, [data-snooze-settings] button { min-block-size: 44px; }
  [data-snooze-select]::after { inset-block-end: 20px; }
  [data-snooze-remove] { inline-size: 44px; }
}
@media (max-width: 740px) {
  [data-snooze-row-controls] { grid-template-columns: minmax(0, 1.5fr) minmax(0, .7fr) minmax(0, 1fr) auto; }
  [data-snooze-preview] { grid-column: 1 / -1; grid-row: 2; min-block-size: 0; }
}
@media (max-width: 480px) {
  [data-snooze-row-controls] { grid-template-columns: repeat(2, minmax(0, 1fr)) auto; }
  [data-snooze-row-controls] label:first-child { grid-column: 1 / -1; }
  [data-snooze-preview] { grid-row: 3; }
}

[data-thread-search] { width: min(520px, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); }
[data-thread-search-list] { max-height: min(410px, 54dvh); }
[data-question-card] {
  width: min(var(--workspace-content), calc(100% - 2 * var(--workspace-gutter)));
  margin-inline: auto;
  margin-block-end: max(12px, env(safe-area-inset-bottom));
}
@media (min-width: 75rem) {
  [data-workspace-layout][data-details-open="true"] [data-workspace-rail],
  [data-workspace-layout][data-diff-open="true"] [data-workspace-rail],
  [data-workspace-layout][data-files-open="true"] [data-workspace-rail],
  [data-workspace-layout][data-preview-open="true"] [data-workspace-rail] {
    position: static; z-index: auto; flex: 0 0 clamp(16.75rem, 22vw, 21rem); width: auto;
    padding: 12px 12px 12px 0; max-height: 100%; min-block-size: 0;
    overflow: hidden; display: flex; flex-direction: column; gap: 8px;
  }
  [data-workspace-layout][data-details-open="true"] [data-workspace-actions] { display: flex; flex-shrink: 0; }
  [data-workspace-layout][data-details-open="false"] [data-workspace-actions] { display: none; }
  [data-workspace-layout][data-diff-open="true"] [data-diff] { flex: 1; }
  [data-workspace-layout][data-diff-open="true"] [data-workspace-rail] { flex-basis: clamp(27rem, 40vw, 43rem); }
  [data-workspace-layout][data-files-open="true"] [data-workspace-rail] { flex-basis: clamp(27rem, 36vw, 39rem); }
  [data-workspace-layout][data-preview-open="true"] [data-workspace-rail] { flex-basis: clamp(27rem, 38vw, 44rem); }
  [data-workspace-layout]:is([data-files-open="true"], [data-diff-open="true"], [data-preview-open="true"]) [data-workspace-actions] { display: none; }
  [data-files][data-file-selected="true"] [data-workspace-files-body] { grid-template-columns: minmax(8rem, 32%) minmax(0, 1fr); }
  [data-workspace-file-detail] { border-inline-start: 1px solid var(--workspace-line); }
  [data-workspace-file-back] { display: none; }
  [data-workspace-actions-scrim]:not([hidden]) { display: none; }
}
@media (max-width: 74.999rem) {
  [data-workspace-layout]:is([data-diff-open="true"], [data-files-open="true"], [data-preview-open="true"])
    :is([data-workspace-lane], [data-workspace-actions], [data-header-terminal]) { display: none; }
  [data-workspace-layout][data-diff-open="true"] [data-workspace-actions-toggle] { display: none; }
  [data-workspace-layout]:is([data-diff-open="true"], [data-files-open="true"], [data-preview-open="true"]) [data-workspace-rail] {
    position: static; display: flex; flex: 1; max-height: 100%; overflow: hidden;
    padding: 8px var(--workspace-gutter) max(8px, env(safe-area-inset-bottom)); width: 100%;
  }
  [data-diff]:not([hidden]) { flex: 1; }
  [data-files][data-file-selected="true"] [data-workspace-files-tree] { display: none; }
}
@media (min-width: 64rem) and (max-width: 74.999rem) {
  [data-workspace-layout][data-preview-open="true"] [data-workspace-lane] { display: flex; }
  [data-workspace-layout][data-preview-open="true"] [data-workspace-rail] {
    flex: 0 0 clamp(22rem, 38vw, 31rem); width: auto; padding-inline: 0 var(--workspace-gutter);
  }
}
@media (max-width: 47.999rem) {
  [data-workspace-layout] { --workspace-header-height: 52px; }
  [data-workspace-header] { gap: 4px; padding-inline: 6px; min-width: 0; }
  [data-workspace-heading] { flex-flow: column; gap: 2px; align-items: stretch; }
  [data-workspace-project] { max-width: 100%; font-size: 11px; line-height: 1.15; }
  [data-workspace-folder] { width: 12px; height: 12px; }
  [data-workspace-separator] { display: none; }
  [data-session-state] { padding-inline: 3px; flex-shrink: 0; }
  [data-header-actions] { gap: 1px; }
  [data-header-files], [data-header-editor], [data-header-project-scripts], [data-header-preview] { display: none; }
  [data-workspace-editor], #harness-project-scripts { inset-block: auto 0; margin-block: 0; width: 100%; max-width: none; border-radius: 12px 12px 0 0; padding-block-end: env(safe-area-inset-bottom); }
  #harness-project-scripts button, #harness-project-scripts label:has(input[type="checkbox"]) { min-height: 44px; }
  [data-project-setup-status] button { min-height: 44px; }
  #harness-project-scripts .harness-icon-button { min-width: 44px; }
  [data-workspace-actions] [data-workspace-editor-menu] { display: flex; min-height: 44px; }
  [data-workspace-layout]:has([data-workspace-actions-toggle]) :is([data-header-settings], [data-thread-search-toggle]) { display: none; }
  [data-workspace-header] .harness-icon-button { width: 36px; height: 40px; flex-basis: 36px; }
  [data-settings-modal] { inset: 0; width: 100%; height: 100dvh; max-width: none; border-radius: 0; }
  [data-settings-shell] { grid-template-columns: 3.5rem minmax(0, 1fr); }
  [data-settings-navigation] { padding: 8px 6px; }
  [data-settings-navigation] button:not([hidden]) { min-height: 44px; justify-content: center; }
  [data-settings-tab-label] { display: none; }
  [data-settings-header] { flex-wrap: wrap; gap: 5px; padding-inline: 10px; }
  [data-settings-search] { order: 1; inline-size: 100%; }
  [data-settings-panel] { padding: 16px; }
  [data-sidebar-toggle], [data-header-settings], [data-thread-search-toggle] { display: inline-grid; place-items: center; }
  [data-harness-sidebar], [data-sidebar-resize] { display: none; }
  [data-harness-shell] [data-harness-sidebar][data-open="true"] {
    display: flex; position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 65;
    width: min(250px, 85vw);
  }
  [data-sidebar-scrim]:not([hidden]) { display: block; position: fixed; inset: 0; z-index: 64; background: rgb(0 0 0 / 45%); }
  [data-workspace-layout]:has([data-compact-thread-undo]:not([hidden]) [data-thread-undo]:not([hidden])) { grid-template-rows: var(--workspace-header-height) auto minmax(0, 1fr); }
  [data-compact-thread-undo]:not([hidden]):has([data-thread-undo]:not([hidden])) { display: block; }
  [data-workspace-branch] { display: none; }
  [data-transcript] { padding-block-start: var(--harness-transcript-top, 16px); }
  [data-composer] { padding: 8px 9px; }
  [data-prompt] { font-size: 16px; }
  [data-workspace-draft]:has([data-composer]) { padding-block-end: min(10dvh, 80px); }
}
@media (max-width: 47.999rem) and (pointer: coarse) {
  [data-workspace-header] .harness-icon-button { width: 40px; height: 44px; flex-basis: 40px; }
  [data-navigation-chrome] button, [data-navigation-footer] button { min-height: 44px; }
  [data-sidebar-row]:has(> [data-draft-discard-row]) > [data-sidebar-item], [data-navigation-content] [data-saved-draft-link] { min-height: 44px; padding-inline-end: 52px; }
  [data-sidebar-row] > [data-draft-discard-row], [data-saved-draft] > [data-draft-discard-row] { width: 44px; height: 44px; }
  [data-thread-undo] button, [data-navigation-undo] [data-thread-undo] button { min-height: 44px; }
  [data-composer-toolbar] button:not([hidden]), [data-composer-toolbar] select { min-height: 44px; }
  [data-send][data-primary-send="true"]:not([hidden]) { inline-size: 44px; }
}
`

/**
 * Tool-call rows. Three states, three colours: running, succeeded, failed —
 * a tool that is still going must not look like one that finished, or a hung
 * command reads as a completed one. Attribute-state selectors and keyframes
 * have no utility form, so they ship as a preflight.
 */
const TOOL_DOT = `
.tool-dot { display: inline-block; width: 6px; height: 6px; border-radius: 9999px; background: currentColor; opacity: 0.35; }
[data-tool-state="running"] .tool-dot { background: rgb(245 158 11); opacity: 1; animation: tool-pulse 1.1s ease-in-out infinite; }
[data-tool-state="ok"] .tool-dot { background: rgb(34 197 94); opacity: 0.9; }
[data-tool-state="failed"] .tool-dot { background: rgb(239 68 68); opacity: 1; }
/* A failed tool is the one row worth reading twice. */
[data-tool-state="failed"] .font-mono { opacity: 1; }
@keyframes tool-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
/* Respect the setting rather than animating regardless - this dot sits in a
  transcript people watch for minutes at a time. */
@media (prefers-reduced-motion: reduce) { [data-tool-state="running"] .tool-dot { animation: none; } }
`

/**
 * The wait between sending a prompt and the first token: three pulsing dots
 * under the Agent label, because a bare label over blank space reads as a
 * hang. Same reduced-motion respect as the tool dot.
 */
const THINKING_DOTS = `
.thinking-dots { display: inline-flex; gap: 4px; padding: 4px 0; }
.thinking-dots span { width: 5px; height: 5px; border-radius: 9999px; background: currentColor; opacity: 0.25; animation: thinking-pulse 1.2s ease-in-out infinite; }
.thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes thinking-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) { .thinking-dots span { animation: none; opacity: 0.5; } }
`

/**
 * The terminal. One dark scheme regardless of page theme — a terminal is its
 * own surface, and shells assume a dark ground. The 16-color palette is the
 * app's token set for the t-fg-N and t-bg-N classes from `@harness/ansi`
 * (whose own rules are the preflight below this one). The toggle lives in the
 * toolbar so it leaves space for the composer at phone widths.
 */
const TERMINAL_PANEL = `
.terminal-panel {
  flex: 0 0 max(120px, var(--terminal-dock-height, 31dvh)); min-width: 0; overflow: hidden;
  background: #16181f; border-block-start: 1px solid rgb(255 255 255 / 16%);
  display: flex; flex-direction: column;
  --t-color-0: #1c1e26; --t-color-1: #e05561; --t-color-2: #8cc265;
  --t-color-3: #d18f52; --t-color-4: #4aa5f0; --t-color-5: #c162de;
  --t-color-6: #42b3c2; --t-color-7: #d7dae0; --t-color-8: #5f6672;
  --t-color-9: #ff616e; --t-color-10: #a5e075; --t-color-11: #f0a45d;
  --t-color-12: #4dc4ff; --t-color-13: #de73ff; --t-color-14: #4cd1e0;
  --t-color-15: #ffffff;
}
[data-terminal-resize] {
  display: grid; place-items: center; flex: 0 0 7px; cursor: ns-resize; touch-action: none;
}
[data-terminal-resize]::after {
  content: ''; width: 30px; height: 2px; border-radius: 2px; background: #687285;
}
[data-terminal-resize]:focus-visible { outline: 1px solid #8db1ee; outline-offset: -1px; }
[data-terminal-toolbar] {
  display: flex; align-items: center; justify-content: space-between; gap: 4px; padding-inline: 4px;
  color: #d7dae0; font-size: 12px; border-block-end: 1px solid rgb(255 255 255 / 16%);
}
[data-terminal-tabs] {
  display: flex; flex: 1; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: thin;
}
[data-terminal-tabs] [role="tab"] {
  flex: 0 0 auto; padding-inline: 9px; min-height: 32px; border-block-end: 2px solid transparent;
  white-space: nowrap; font-size: 12px; color: #aeb4c1;
}
[data-terminal-tabs] [role="tab"]:hover,
[data-terminal-tabs] [role="tab"][aria-selected="true"] {
  background: rgb(255 255 255 / 7%); color: #f3f4f6;
}
[data-terminal-tabs] [role="tab"][aria-selected="true"] { border-block-end-color: #8db1ee; }
[data-terminal-tabs] [role="tab"]:focus-visible,
[data-terminal-pane-picker] button:focus-visible,
.terminal-host:focus-visible { outline: 1px solid #8db1ee; outline-offset: -2px; }
[data-terminal-toolbar] button:disabled { opacity: .46; cursor: default; }
[data-terminal-restart-icon] { display: none; }
[data-terminal-activity] { white-space: nowrap; }
[data-terminal-output] {
  display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden;
}
[data-terminal-output][data-direction="rows"] { flex-direction: column; }
[data-terminal-pane] {
  display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; min-height: 0;
}
@media (min-width: 48rem) {
  [data-terminal-output][data-direction="columns"] [data-terminal-pane] + [data-terminal-pane] {
    border-inline-start: 1px solid rgb(255 255 255 / 18%);
  }
  [data-terminal-output][data-direction="rows"] [data-terminal-pane] + [data-terminal-pane] {
    border-block-start: 1px solid rgb(255 255 255 / 18%);
  }
}
[data-terminal-pane-picker] {
  display: flex; flex: 0 0 auto; gap: 2px; align-items: center; overflow-x: auto;
  padding-inline: 4px; border-block-end: 1px solid rgb(255 255 255 / 12%);
}
[data-terminal-pane-picker] button {
  flex: 0 0 auto; padding-inline: 7px; min-height: 26px; color: #aeb4c1; font-size: 11px;
}
[data-terminal-pane-picker] button[aria-pressed="true"] { color: #edf2fb; background: rgb(141 177 238 / 14%); }
.terminal-host {
  flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 8px 10px;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #d7dae0; white-space: pre;
}
@media (max-width: 47.999rem) {
  [data-terminal-output] [data-terminal-pane]:not([data-active="true"]) { display: none; }
  [data-terminal-pane-picker] button { min-height: 36px; padding-inline: 10px; }
  [data-terminal-toolbar] .harness-icon-button { width: 34px; height: 36px; flex-basis: 34px; }
  [data-terminal-restart] { width: 34px; height: 36px; padding: 0; }
  [data-terminal-restart-icon] { display: inline-block; vertical-align: middle; }
  [data-terminal-restart-label] { display: none; }
  [data-terminal-tabs] [role="tab"] { max-inline-size: 100%; overflow: hidden; text-overflow: ellipsis; }
}
.terminal-toggle {
  display: grid; place-items: center; flex: 0 0 32px; height: 32px;
  border-radius: 6px; cursor: pointer;
}
/* The measuring ruler: laid out in the host's font so its box is the truth
  about cell size, but invisible and out of flow. */
.term-metric {
  position: absolute; visibility: hidden; white-space: pre;
}
`

export default {
  content: [
    './resources/views/**/*.{stx,html}',
    './resources/**/*.{stx,html}',
    './storage/framework/defaults/resources/views/**/*.{stx,html}',
    './storage/framework/defaults/resources/components/**/*.{stx,html}',
    './storage/framework/core/error-handling/src/views/**/*.{stx,html}',
  ],
  preflights: [
    { getCSS: () => HIDDEN_PIN },
    { getCSS: () => RESPONSIVE_SHELL },
    { getCSS: () => TRANSCRIPT_MARKDOWN },
    syntaxColors,
    approvalLayout,
    { getCSS: () => TOOL_DOT },
    { getCSS: () => THINKING_DOTS },
    { getCSS: () => TERMINAL_PANEL },
    { getCSS: () => TERMINAL_CSS },
  ],
} satisfies Partial<CrosswindConfig>
