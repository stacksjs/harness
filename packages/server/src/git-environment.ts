const checkoutVariables = [
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

/** Bind Git to the checkout passed by the caller, including when launched from a Git hook. */
export function workspaceGitEnvironment(overrides?: Record<string, string>) {
  const environment = { ...process.env }
  for (const name of checkoutVariables) delete environment[name]
  return { ...environment, ...overrides }
}
