/**
 * The only module both the harness server and its clients import.
 *
 * Keeping the contract in one place is what lets the driver layer stay the sole
 * component that knows which agent is behind a session: everything above it
 * names a session and speaks these types.
 */

export { CborError, decode, encode } from './cbor'
export type {
  ApprovalDecision,
  ApprovalChoice,
  ApprovalScope,
  ConnectorApproval,
  ClientCommand,
  CodexTurnOptions,
  CodexTurnSelection,
  Command,
  CommandEnvelope,
  CommandType,
  DriverKind,
  InternalCommand,
  ModelFavorite,
} from './commands'
export { codexSelectionLabel, isClearCommand, isClientCommand, isCompactCommand } from './commands'
export type { CheckoutIntent, CombinedWorktreeIntent, ConversationRewindPoint, EventBase, EventPayload, EventType, ForkSource, HarnessEvent, ProviderContextUsage, PullRequestCheckout, RepositoryCheckpoint, RepositoryPullRequest, WorktreeIntent, WorktreeSelection } from './events'
export { GLOBAL_SESSION_ID, isGlobalEvent } from './events'
export type { InputAnswer, InputOption, InputQuestion, InputResponse } from './input'
export { inputResponseValues, MAX_INPUT_ANSWER_LENGTH, validInputAnswers } from './input'
export { MAX_QUESTION_ATTACHMENTS, MAX_QUESTION_FILE_BYTES, MAX_QUESTION_IMAGE_BYTES, MAX_QUESTION_TOTAL_IMAGE_BYTES, questionAllowsAttachments } from './input'
export type { QuestionAttachment } from './input'
export type { ComposerAttachment, ComposerUploads } from './composer-attachments'
export { MAX_COMPOSER_ATTACHMENTS } from './composer-attachments'

export { applyFollowUpEvent } from './follow-ups'
export type { FollowUpQueue, QueuedFollowUp, SteeringOutcome } from './follow-ups'

export { acceptedClaudeAccountCompaction, acceptedSettings, defaultHostSettings, defaultSnoozePresets, hostSettings, maxSnoozeMinutes, maxSnoozePresets, sameSnoozePresets, settingsDelta, snoozeDays, snoozePresetKey } from './settings'
export { claudeCompactionReturnAt } from './idle-compaction'
export type { ClaudeAccountCompaction, ClaudeIdleCompaction, FollowUpBehavior, HostSettings, SnoozeDay, SnoozePreset, TerminalShell } from './settings'

export { maximumThreadSnooze, pinOrder, threadDisplayTitle, threadPlacementKeys, threadUndoDuration } from './thread-navigation'
export type { ThreadDrop, ThreadNavigation, ThreadOrganizationAction, ThreadPlacement, ThreadUndoOffer, ThreadUndoRecord, ThreadUndoResult, ThreadUndoScopeUpdate } from './thread-navigation'
