import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { derivedId } from '@harness/engine'

export function scratchWorkspacePath(root: string, commandId: string, label: unknown): string {
  const date = new Date().toISOString().slice(0, 10)
  const words = typeof label === 'string' ? label.slice(0, 200).toLowerCase().match(/[\p{L}\p{N}]+/gu) : null
  const name = words?.slice(0, 6).join('-').slice(0, 60) || 'session'
  return join(root, `${date}-${name}-${derivedId(commandId).toString(36)}`)
}

/** A scratch directory is created after its event commit, when first used. */
export async function openScratchWorkspace(path: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const canonicalParent = await realpath(parent)
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (await realpath(path) !== join(canonicalParent, basename(path)))
    throw new Error('The scratch folder no longer points to its original location.')
}
