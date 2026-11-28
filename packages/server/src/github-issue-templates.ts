/**
 * Issue form formatting adapted from T3 Code's gitHubIssueTemplates.ts at
 * 431da7f4e55b82b386e68a9f32c543fac2efedf5.
 * Copyright (c) 2026 T3 Tools Inc. MIT. See ../../drivers/T3CODE-LICENSE.md.
 */

import type { GitHubIssueRepository } from './issue-repositories'
import { issueTextLimits } from './issue-text'
import { repositoryGitHubRequest, RepositoryPullRequestError } from './repository-pull-request'

const templateLimit = 100
const yamlLimit = 65_536

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function names(value: unknown, limit: number): string[] {
  const items = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : []
  return items.slice(0, limit).map(value => text(value).trim()).filter(Boolean)
}

function nodes(value: unknown, field: string) {
  const { nodes } = record(value)
  return Array.isArray(nodes) ? nodes.map(node => record(node)[field]) : []
}

function fieldMarkdown(value: unknown) {
  const field = record(value)
  const type = text(field.type)
  if (!type) return ''
  const attributes = record(field.attributes)
  const validations = record(field.validations)
  if (type === 'markdown') return text(attributes.value)
  const sections = ['### ' + (text(attributes.label) || text(field.id) || type), text(attributes.description)]
  if (validations.required === true) sections.push('Required.')
  if (typeof attributes.placeholder === 'string' && attributes.placeholder.trim())
    sections.push('Example:\n> ' + attributes.placeholder.trim().replaceAll('\n', '\n> '))
  if (typeof attributes.render === 'string' && attributes.render) sections.push('Format: ' + attributes.render)
  if (typeof validations.accept === 'string' && validations.accept) sections.push('Accepted files: ' + validations.accept)
  const options = Array.isArray(attributes.options) ? attributes.options.slice(0, templateLimit) : []
  if (type === 'checkboxes') {
    sections.push(options.map(option => {
      const label = text(option) || text(record(option).label)
      return '- [ ] ' + label + (record(option).required === true ? ' (required)' : '')
    }).join('\n'))
  }
  if (type === 'dropdown') {
    const chosen = attributes.default
    const defaults = Array.isArray(chosen) ? chosen : [chosen]
    sections.push(attributes.multiple === true ? 'Choose one or more:' : 'Choose one:')
    sections.push(options.map((option, index) =>
      '- ' + (text(option) || text(record(option).label)) + (defaults.includes(index) ? ' (default)' : ''),
    ).join('\n'))
  }
  sections.push(text(attributes.value))
  return sections.filter(Boolean).join('\n\n')
}

function template(key: string, name: unknown, about: unknown, title: unknown, body: unknown, labels: unknown, assignees: unknown) {
  return { key, name: text(name).trim().slice(0, 255) || key, about: text(about).slice(0, 1024),
    title: text(title).slice(0, issueTextLimits.title), body: text(body).slice(0, issueTextLimits.body),
    labels: names(labels, 50), assignees: names(assignees, 25) }
}

function unreadable() {
  return new RepositoryPullRequestError('GitHub returned unreadable issue templates.')
}

export async function githubIssueTemplates(repository: GitHubIssueRepository, credential: string, signal: AbortSignal) {
  const [owner, name] = repository.name.split('/')
  const reply = await repositoryGitHubRequest(repository.path, 'graphql', {
    query: `query HarnessIssueTemplates($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        nameWithOwner
        templateDirectory: object(expression: "HEAD:.github/ISSUE_TEMPLATE") {
          __typename
          ... on Tree { entries { name object { __typename ... on Blob { text isTruncated } } } }
        }
        issueTemplates {
          filename name about title body
          labels(first: 50) { nodes { name } }
          assignees(first: 25) { nodes { login } }
        }
      }
    }`, variables: { owner, name },
  }, signal, credential)
  const payload = record(reply.body)
  const repo = record(record(payload.data).repository)
  if (reply.status !== 200 || (Array.isArray(payload.errors) && payload.errors.length)
    || text(repo.nameWithOwner).toLowerCase() !== repository.name.toLowerCase()) throw unreadable()
  const templates = new Map<string, ReturnType<typeof template>>()
  const validKey = (key: string) => key.trim() && key.length <= 255 && !/\p{Cc}/u.test(key)
  const markdown = Array.isArray(repo.issueTemplates) ? repo.issueTemplates.slice(0, templateLimit) : []
  for (const value of markdown) {
    const raw = record(value)
    const key = text(raw.filename)
    if (!validKey(key)) continue
    const basename = key.slice(key.lastIndexOf('/') + 1)
    templates.set(basename, template(key, raw.name, raw.about, raw.title, raw.body, nodes(raw.labels, 'name'), nodes(raw.assignees, 'login')))
  }
  let blankIssuesEnabled = true
  const directory = record(repo.templateDirectory)
  const entries = directory.__typename === 'Tree' && Array.isArray(directory.entries) ? directory.entries : []
  // Read the config independently of the limit on the number of presented forms.
  const yaml = entries.map(record).filter(entry => /\.ya?ml$/iu.test(text(entry.name)))
  const config = yaml.find(entry => /^config\.ya?ml$/iu.test(text(entry.name)))
  const forms = yaml.filter(entry => entry !== config).slice(0, templateLimit)
  for (const entry of config ? [config, ...forms] : forms) {
    const key = text(entry.name)
    if (!validKey(key)) continue
    const blob = record(entry.object)
    if (blob.__typename !== 'Blob' || blob.isTruncated !== false || typeof blob.text !== 'string' || blob.text.length > yamlLimit)
      throw unreadable()
    let raw: Record<string, unknown>
    try {
      const parsed = Bun.YAML.parse(blob.text)
      if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw unreadable()
      raw = record(parsed)
    }
    catch {
      if (entry === config) throw unreadable()
      continue
    }
    if (entry === config) {
      if (raw.blank_issues_enabled !== undefined && typeof raw.blank_issues_enabled !== 'boolean') throw unreadable()
      blankIssuesEnabled = raw.blank_issues_enabled !== false
      continue
    }
    if (!text(raw.name).trim() || typeof raw.description !== 'string' || !Array.isArray(raw.body)) continue
    const body = raw.body.slice(0, templateLimit).map(fieldMarkdown).filter(Boolean).join('\n\n')
    templates.set(key, template(key, raw.name, raw.description, raw.title, body, raw.labels, raw.assignees))
  }
  return { blankIssuesEnabled, templates: [...templates.values()] }
}
