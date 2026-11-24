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

const RESPONSIVE_SHELL = `
[data-sidebar-toggle], [data-sidebar-scrim], [data-workspace-actions-toggle],
[data-workspace-actions-scrim], [data-workspace-action-label] { display: none; }
[data-workspace-actions] { display: flex; align-items: center; gap: 8px; margin-inline-start: auto; }
[data-workspace-actions] + [data-account-button], [data-thread-search-toggle] + [data-account-button] { margin-inline-start: 0; }
[data-account-button] { flex-shrink: 0; }
[data-thread-search-toggle] {
  display: grid; place-items: center; flex: 0 0 32px; height: 32px; border-radius: 6px;
}
[data-thread-search-toggle]:hover, [data-thread-search-toggle]:focus-visible,
[data-thread-search-option]:hover, [data-thread-search-option][aria-selected="true"] {
  background: rgb(127 127 127 / 15%);
}
[data-harness-sidebar] { width: var(--harness-sidebar-width, 250px); }
[data-sidebar-resize] {
  z-index: 1; flex: 0 0 6px; margin-inline-start: -3px;
  cursor: col-resize; touch-action: none;
}
[data-sidebar-resize]:hover, [data-sidebar-resize]:focus-visible {
  background: rgb(127 127 127 / 24%);
}
[data-project-dialog]::backdrop, [data-settings-modal]::backdrop,
[data-thread-search]::backdrop { background: rgb(0 0 0 / 45%); }
[data-project-dialog] { width: min(480px, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); }
[data-settings-modal] { width: min(360px, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); }
[data-thread-search] { width: min(520px, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); }
[data-thread-search-list] { max-height: min(410px, 54dvh); }
[data-composer] { width: 100%; max-width: 820px; margin-inline: auto; }
[data-transcript] > [data-turn], [data-transcript] > [data-approval] {
  max-width: 788px; margin-inline: auto;
}
@media (max-width: 767px) {
  [data-workspace-header] { gap: 8px; padding-inline: 12px; }
  [data-workspace-title] { flex: 1 1 auto; }
  [data-sidebar-toggle] {
    display: grid; place-items: center; flex: 0 0 32px; height: 32px;
    border-radius: 6px;
  }
  [data-harness-sidebar] { display: none; }
  [data-sidebar-resize] { display: none; }
  [data-harness-sidebar][data-open="true"] {
    display: block; position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 65;
    width: min(250px, 85vw); background: var(--harness-sidebar-surface, #fafafa);
  }
  .dark [data-harness-sidebar] { --harness-sidebar-surface: #171717; }
  [data-sidebar-scrim] { display: block; position: fixed; inset: 0; z-index: 64; background: rgb(0 0 0 / 45%); }
  [data-session-state][data-state="idle"], [data-session-driver], [data-workspace-branch] { display: none; }
  [data-workspace-actions-toggle] {
    display: grid; place-items: center; flex: 0 0 36px; height: 36px;
    position: relative; z-index: 46; border-radius: 8px; border: 1px solid rgb(127 127 127 / 25%);
  }
  [data-workspace-actions-toggle][aria-expanded="true"] { background: rgb(127 127 127 / 15%); }
  [data-workspace-actions-scrim] { display: block; position: fixed; inset: 0; z-index: 44; }
  [data-workspace-actions] { display: none; }
  [data-workspace-actions][data-open="true"] {
    display: flex; flex-direction: column; align-items: stretch;
    position: absolute; inset-inline-end: 12px; inset-block-start: calc(100% + 4px); z-index: 45;
    min-width: 152px; padding: 4px; gap: 2px; background: var(--harness-actions-surface, #fafafa);
    border: 1px solid rgb(127 127 127 / 25%); border-radius: 10px;
    box-shadow: 0 8px 20px rgb(0 0 0 / 14%);
  }
  .dark [data-workspace-actions] { --harness-actions-surface: #171717; }
  [data-workspace-actions] > button {
    display: flex; align-items: center; justify-content: flex-start; gap: 8px;
    min-height: 36px; width: 100%; padding-inline: 8px; border: 0; font-size: 13px; text-align: start;
  }
  [data-workspace-actions] > button:hover, [data-workspace-actions] > button:focus-visible {
    background: rgb(127 127 127 / 16%); border-radius: 6px;
  }
  [data-workspace-action-label] { display: inline; }
  [data-composer] {
    grid-template-columns: minmax(0, 1fr) auto;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
  }
  [data-prompt] { grid-column: 1 / -1; }
  [data-driver-picker] { justify-self: start; }
  section[data-terminal] { max-height: calc(100dvh - 175px); bottom: 128px; }
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
  position: fixed; right: 16px; bottom: 118px;
  width: min(720px, calc(100vw - 32px)); height: 340px; z-index: 60;
  border-radius: 10px; overflow: hidden;
  background: #16181f; border: 1px solid rgb(255 255 255 / 12%);
  box-shadow: 0 12px 40px rgb(0 0 0 / 45%);
  display: flex; flex-direction: column;
  --t-color-0: #1c1e26; --t-color-1: #e05561; --t-color-2: #8cc265;
  --t-color-3: #d18f52; --t-color-4: #4aa5f0; --t-color-5: #c162de;
  --t-color-6: #42b3c2; --t-color-7: #d7dae0; --t-color-8: #5f6672;
  --t-color-9: #ff616e; --t-color-10: #a5e075; --t-color-11: #f0a45d;
  --t-color-12: #4dc4ff; --t-color-13: #de73ff; --t-color-14: #4cd1e0;
  --t-color-15: #ffffff;
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
    { getCSS: () => TOOL_DOT },
    { getCSS: () => THINKING_DOTS },
    { getCSS: () => TERMINAL_PANEL },
    { getCSS: () => TERMINAL_CSS },
  ],
} satisfies Partial<CrosswindConfig>
