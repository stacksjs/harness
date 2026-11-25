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
  --workspace-navigation: #f5f5f4;
  --workspace-line: rgb(26 32 44 / 12%);
  --workspace-hover: rgb(26 32 44 / 7%);
  --workspace-accent: #48679a;
  --workspace-content: 47rem;
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
[data-navigation-footer] { padding: 6px 8px max(6px, env(safe-area-inset-bottom)); }
[data-navigation-content] { position: relative; flex: 1; min-height: 0; overflow: hidden; isolation: isolate; }
[data-harness-shell] [data-navigation-content] [data-stx-sidebar][data-sidebar-spaces="true"] {
  width: 100% !important;
  background: color-mix(in srgb, var(--workspace-navigation) 95%, var(--stx-space-accent, var(--workspace-accent))) !important;
  color: inherit;
}
[data-navigation-content] :is(.stx-sidebar-rim, .stx-sidebar-rim::after) { display: none; }
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
  display: grid; grid-template: 44px minmax(0, 1fr) / minmax(0, 1fr);
}
[data-workspace-header] { border-color: var(--workspace-line); }
[data-workspace-heading] { flex: 1 1 auto; }
[data-workspace-project] { max-width: 14ch; }
[data-header-actions] { display: flex; gap: 4px; align-items: center; flex: 0 0 auto; }
[data-workspace-content] { display: flex; position: relative; min-height: 0; min-width: 0; }
[data-workspace-lane] { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
[data-transcript] { padding-inline: var(--workspace-gutter); padding-block: 24px 16px; }
[data-transcript] > :is([data-turn], [data-follow-ups]) { max-width: var(--workspace-content); margin-inline: auto; }
[data-user-prompt] { background: var(--workspace-hover); }
[data-composer] {
  box-sizing: border-box;
  grid-template-columns: minmax(0, 1fr) auto;
  width: min(var(--workspace-content), calc(100% - 2 * var(--workspace-gutter)));
  margin: 4px auto max(12px, env(safe-area-inset-bottom));
  padding: 9px 10px;
  background: var(--workspace-surface);
  border: 1px solid var(--workspace-line); border-radius: 15px;
}
[data-composer]:focus-within { border-color: color-mix(in srgb, var(--workspace-accent) 60%, var(--workspace-line)); }
[data-prompt] { grid-column: 1 / -1; }
[data-prompt]:focus-visible { outline: none !important; }
[data-driver-picker] { justify-self: end; }
[data-workspace-rail] {
  position: absolute; inset-block-start: 5px; inset-inline-end: var(--workspace-gutter);
  z-index: 45; width: min(21rem, calc(100% - 2 * var(--workspace-gutter)));
  max-height: calc(100% - 14px); overflow: auto; pointer-events: none;
}
[data-workspace-actions], [data-diff] {
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
[data-diff]:not([hidden]) { margin-block-start: 5px; max-height: min(56dvh, 30rem); }
[data-project-dialog]::backdrop, [data-settings-modal]::backdrop,
[data-thread-search]::backdrop { background: rgb(0 0 0 / 45%); }
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
[data-project-dialog] { width: min(480px, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); }
[data-settings-modal] { width: min(1060px, calc(100% - 3rem)); height: min(720px, calc(100dvh - 3rem)); max-height: none; border-radius: 14px; }
[data-settings-shell] {
  display: grid; grid-template: auto minmax(0, 1fr) / 12rem minmax(0, 1fr);
  height: 100%;
}
[data-settings-header] { grid-area: 1 / 2; padding: 8px 12px 8px 16px; border-bottom: 1px solid var(--workspace-line); }
[data-settings-navigation] { grid-area: 1 / 1 / 3 / 2; display: flex; flex-direction: column; gap: 4px; padding: 12px 8px; min-height: 0; overflow: auto; border-inline-end: 1px solid var(--workspace-line); }
[data-settings-navigation] button { display: flex; align-items: center; gap: 8px; min-height: 36px; padding-inline: 8px; text-align: start; font-size: 13px; border-radius: 6px; }
[data-settings-navigation] button:is(:hover, :focus-visible, [aria-current="page"]) { background: var(--workspace-hover); }
[data-settings-panel] { grid-area: 2 / 2; min-height: 0; overflow: auto; padding: 20px 24px; }
[data-settings-pane] { max-width: 42rem; margin-inline: auto; }
[data-settings-section] { width: fit-content; margin-block-end: 16px; font-size: 18px; font-weight: 650; outline-offset: 3px; }
[data-settings-panel] select { min-height: 36px; }
[data-thread-search] { width: min(520px, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); }
[data-thread-search-list] { max-height: min(410px, 54dvh); }
[data-question-card] {
  width: min(var(--workspace-content), calc(100% - 2 * var(--workspace-gutter)));
  margin-inline: auto;
  margin-block-end: max(12px, env(safe-area-inset-bottom));
}
@media (min-width: 75rem) {
  [data-workspace-layout][data-details-open="true"] [data-workspace-rail],
  [data-workspace-layout][data-diff-open="true"] [data-workspace-rail] {
    position: static; z-index: auto; flex: 0 0 16.25rem; width: auto;
    padding: 16px 12px 12px 0; max-height: 100%; overflow: auto;
  }
  [data-workspace-layout][data-details-open="true"] [data-workspace-actions] { display: flex; }
  [data-workspace-layout][data-details-open="false"] [data-workspace-actions] { display: none; }
  [data-workspace-actions-scrim]:not([hidden]) { display: none; }
}
@media (max-width: 47.999rem) {
  [data-workspace-header] { gap: 5px; padding-inline: 8px; min-width: 0; }
  [data-workspace-project] { max-width: 8ch; }
  [data-session-state] { padding-inline: 3px; }
  [data-header-pane] { display: none; }
  [data-settings-modal] { inset: 0; width: 100%; height: 100dvh; max-width: none; border-radius: 0; }
  [data-settings-shell] { grid-template-columns: 3.5rem minmax(0, 1fr); }
  [data-settings-navigation] { padding: 8px 6px; }
  [data-settings-navigation] button { min-height: 44px; justify-content: center; }
  [data-settings-tab-label] { display: none; }
  [data-settings-panel] { padding: 16px; }
  [data-sidebar-toggle], [data-header-settings], [data-thread-search-toggle] { display: inline-grid; place-items: center; }
  [data-harness-sidebar], [data-sidebar-resize] { display: none; }
  [data-harness-shell] [data-harness-sidebar][data-open="true"] {
    display: flex; position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 65;
    width: min(250px, 85vw);
  }
  [data-sidebar-scrim]:not([hidden]) { display: block; position: fixed; inset: 0; z-index: 64; background: rgb(0 0 0 / 45%); }
  [data-session-state][data-state="idle"], [data-session-driver], [data-workspace-branch] { display: none; }
  [data-transcript] { padding-block-start: 16px; }
  [data-diff]:not([hidden]) { max-height: 45dvh; }
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
  flex: 0 0 clamp(120px, 31dvh, 340px); min-width: 0; overflow: hidden;
  background: #16181f; border-block-start: 1px solid rgb(255 255 255 / 16%);
  display: flex; flex-direction: column;
  --t-color-0: #1c1e26; --t-color-1: #e05561; --t-color-2: #8cc265;
  --t-color-3: #d18f52; --t-color-4: #4aa5f0; --t-color-5: #c162de;
  --t-color-6: #42b3c2; --t-color-7: #d7dae0; --t-color-8: #5f6672;
  --t-color-9: #ff616e; --t-color-10: #a5e075; --t-color-11: #f0a45d;
  --t-color-12: #4dc4ff; --t-color-13: #de73ff; --t-color-14: #4cd1e0;
  --t-color-15: #ffffff;
}
[data-terminal-toolbar] {
  display: flex; align-items: center; justify-content: space-between; padding-inline: 10px 4px;
  color: #d7dae0; font-size: 12px; border-block-end: 1px solid rgb(255 255 255 / 16%);
}
.terminal-host {
  flex: 1; overflow-y: auto; padding: 8px 10px; outline: none;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #d7dae0; white-space: pre;
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
