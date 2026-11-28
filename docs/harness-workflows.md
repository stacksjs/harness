# Manual workflows

Harness can run host-authored TypeScript workflows and save their completed steps in the host database. A manual run belongs to one Harness profile. The same workflow name, profile, and start key always return the original run, including after a version change.

## Configure the host

Set `HARNESS_WORKFLOWS` to a TypeScript file or a directory of TypeScript files you control. Harness loads and executes these modules with host permissions, including any top-level code. The host starts with the valid files and reports definitions it could not load.

Start a fresh host process after editing files. Keep the version and its implementation, including imported helpers, available until its runs finish. Add a new version when changing the workflow. Harness checks the registered run function before resuming an older run.

Save this example as `report.ts`.

```ts
export default {
  name: 'report',
  version: 1,
  async run(input: { name: string }, { step, title }) {
    title('Report for ' + input.name)
    const summary = await step('Prepare summary', () => ({ name: input.name, ready: true }))
    return summary
  },
}
```

A file can export one definition or an array of definitions. Start the host and select a profile ID from `profiles:list`.

```sh
HARNESS_WORKFLOWS=/absolute/path/to/workflows ./buddy harness:serve
./buddy profiles:list
./buddy harness:workflow:list 123
./buddy harness:workflow:start 123 report --key report-2026-11-28 --input '{"name":"Notes"}'
```

Use the `runId` from the response to inspect or control a run.

```sh
./buddy harness:workflow:show 123 "$run_id"
./buddy harness:workflow:resume 123 "$run_id"
./buddy harness:workflow:cancel 123 "$run_id"
```

All five commands accept `--port`. The local CLI reads the host token when paired access is enabled. Run and definition data are available to the local host.

## Follow runs in Harness

Open **Workflows** from the local workspace navigation. Use **Needs you**, **Running**, or **All** to choose a run. Open a step to inspect its result and use the issue link to open the issue in Harness. The page refreshes status while keeping the run open. The **Definitions** view lists loaded versions and file problems.

Use **Start run** to select a workflow, enter JSON input, and set a start key. Select **Resume** on a paused run or **Cancel run** to open the confirmation dialog.

## Save step results and file issues

Give each step a unique name. Completed steps return their saved JSON results when the body replays. Keep the workflow body focused on coordination and put actions inside steps. Use the step's `signal` in asynchronous code so that cancellation or shutdown can interrupt it.

Inside a step, `issues.create` accepts a trusted project ID, absolute path, or unique folder name in the run's profile. Pass a repository key to choose a specific remote on a multi-repository project. The result includes the issue key, display key, and URL, and the run records the issue under the step that created it.

```ts
const issue = await step('File issue', ({ issues }) =>
  issues.create({
    project: 'notes',
    title: 'Check draft recovery',
    body: 'Verify that an unsent draft survives a restart.',
    labels: ['bug'],
  }))
```

The host supports GitHub, GitLab, and Forgejo through their configured host accounts. On first execution, Harness records the account scope and request intent before posting. If a reply is lost, resuming checks the original intent. A changed account pauses the step until the original connection is available.

A failure pauses the run with its saved steps intact. After a crash, the restarted host takes over once the previous lease expires. Cancellation is terminal. Schedules, webhook triggers, agent steps, questions, and editing workflow definitions in the app are tracked in the parity backlog. [P31](https://github.com/stacksjs/harness/issues/41)
