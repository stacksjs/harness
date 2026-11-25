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
  Command,
  CommandEnvelope,
  CommandType,
  DriverKind,
  InternalCommand,
  ModelFavorite,
} from './commands'
export { isClientCommand } from './commands'
export type { EventBase, EventPayload, EventType, HarnessEvent } from './events'
export { GLOBAL_SESSION_ID, isGlobalEvent } from './events'
export type { InputAnswer, InputOption, InputQuestion, InputResponse } from './input'
export { inputResponseValues, MAX_INPUT_ANSWER_LENGTH, validInputAnswers } from './input'
export { MAX_QUESTION_ATTACHMENTS, MAX_QUESTION_FILE_BYTES, MAX_QUESTION_IMAGE_BYTES, MAX_QUESTION_TOTAL_IMAGE_BYTES, questionAllowsAttachments } from './input'
export type { QuestionAttachment } from './input'

export { applyFollowUpEvent } from './follow-ups'
export type { FollowUpQueue, QueuedFollowUp, SteeringOutcome } from './follow-ups'

export { acceptedSettings, defaultHostSettings, hostSettings, settingsDelta } from './settings'
export type { FollowUpBehavior, HostSettings } from './settings'

export { maximumThreadSnooze, pinOrder, threadDisplayTitle } from './thread-navigation'
export type { ThreadNavigation, ThreadOrganizationAction } from './thread-navigation'
