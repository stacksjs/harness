import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const workflowName = /^(?:[a-z\d][a-z\d._-]{0,79})$/iu

export type WorkflowIssue = { key: string, displayKey: string, url: string }

export interface WorkflowIssueInput {
  project: number | string
  repository?: string
  title: string
  body?: string
  labels?: string[]
  assignees?: string[]
}

export interface WorkflowStepContext {
  signal: AbortSignal
  issues: { create: (input: WorkflowIssueInput) => Promise<WorkflowIssue> }
}

export interface WorkflowContext {
  signal: AbortSignal
  title: (value: string) => void
  step: <T>(name: string, execute: (context: WorkflowStepContext) => T | Promise<T>) => Promise<T>
}

export interface WorkflowDefinition {
  name: string
  version: number
  run: (input: unknown, context: WorkflowContext) => unknown
}

export type LoadedWorkflow = WorkflowDefinition & { revision: string }

class DefinitionProblem extends Error {}

async function readWorkflowModule(path: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DefinitionProblem('Loading took more than 20 seconds. Check the file’s top-level code.')), 20_000)
  })
  try {
    // Bun caches imports by filename. A host process restart loads edited source.
    return await Promise.race([import(pathToFileURL(path).href), timeout])
  }
  finally { clearTimeout(timer) }
}

export async function loadWorkflowDefinitions(location: string) {
  const definitions = new Map<string, Map<number, LoadedWorkflow>>()
  const problems: { file: string, message: string }[] = []
  const source = resolve(location)
  const info = await stat(source).catch(() => null)
  if (!info) return { definitions, problems: [{ file: basename(source), message: 'Workflow definitions could not be opened.' }] }
  const files = info.isDirectory()
    ? await readdir(source, { withFileTypes: true }).then(entries =>
      entries.filter(entry => entry.isFile() && !entry.name.startsWith('.') && /^[\w.-]+\.ts$/u.test(entry.name))
        .map(entry => join(source, entry.name)).sort(),
    ).catch(() => null)
    : info.isFile() && /^[\w.-]+\.ts$/u.test(basename(source)) ? [source] : null
  if (!files) return { definitions, problems: [{ file: basename(source), message: 'Choose a TypeScript workflow file or directory.' }] }

  for (const path of files) {
    try {
      const loaded = (await readWorkflowModule(path)).default as unknown
      const exported = Array.isArray(loaded) ? loaded : [loaded]
      const byName = new Map<string, Set<number>>()
      for (const candidate of exported) {
        const definition = candidate as Partial<WorkflowDefinition> | null
        if (!definition || typeof definition.name !== 'string' || !workflowName.test(definition.name)
          || typeof definition.version !== 'number' || !Number.isSafeInteger(definition.version) || definition.version < 1
          || typeof definition.run !== 'function') throw new DefinitionProblem('A definition needs a valid name, version, and run function.')
        const seen = byName.get(definition.name) ?? new Set<number>()
        if (seen.has(definition.version) || definitions.get(definition.name)?.has(definition.version))
          throw new DefinitionProblem('A workflow name and version can only be defined once.')
        seen.add(definition.version)
        byName.set(definition.name, seen)
      }
      for (const definition of exported as WorkflowDefinition[]) {
        const versions = definitions.get(definition.name) ?? new Map<number, LoadedWorkflow>()
        const revision = createHash('sha256').update(definition.run.toString()).digest('hex')
        versions.set(definition.version, { ...definition, revision })
        definitions.set(definition.name, versions)
      }
    }
    catch (error) {
      problems.push({ file: basename(path), message: error instanceof DefinitionProblem
        ? error.message : 'Could not load the workflow. Check the TypeScript export and its imports.' })
    }
  }
  return { definitions, problems }
}
