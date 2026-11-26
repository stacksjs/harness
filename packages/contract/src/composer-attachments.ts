/** Browser references contain no filename or host filesystem path. */
export interface ComposerUploads {
  scope: string
  draft: string
  ids: string[]
}

/** Host-validated references persisted with queued messages and turns. */
export interface ComposerAttachment {
  scope: string
  draft: string
  id: string
  name: string
  size: number
  image: boolean
}

export const MAX_COMPOSER_ATTACHMENTS = 100
