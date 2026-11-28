# Workflows

Harness can run host-authored TypeScript workflows and save their completed steps in the host database. Each run belongs to one Harness profile. The same workflow name, profile, and start key always return the original run, including after a version change.

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

All workflow commands accept `--port`. The local CLI reads the host token when paired access is enabled. Run and definition data are available to the local host.

## Follow runs in Harness

Open **Workflows** from the local workspace navigation. Use **Needs you**, **Running**, or **All** to choose a run. Open a step to inspect its result and use the issue link to open the issue in Harness. The page refreshes status while keeping the run open. The **Definitions** view lists loaded versions, schedules for the selected profile, and file problems.

Use **Start run** to select a workflow, enter JSON input, and set a start key. Select **Resume** on a paused run or **Cancel run** to open the confirmation dialog.

## Schedule runs

Give a workflow a `schedules` list with an ID and Harness profile ID for each entry. Only schedules from the latest loaded workflow version can start runs. Set `enabled: false` to disable one. Restart the host after edits.

```ts
export default {
  name: 'check-drafts',
  version: 1,
  schedules: [
    { id: 'hourly', profile: 123, everyMs: 3_600_000 },
    { id: 'weekday-review', profile: 123, timeOfDay: '09:00', weekdays: [1, 2, 3, 4, 5] },
  ],
  run(input: { scheduledAt: string }) {
    return { scheduledAt: input.scheduledAt }
  },
}
```

An interval starts one full interval after the schedule first loads, with a minimum of one minute. After downtime, it starts one overdue run and counts the next interval from recovery. A daily schedule uses the host time zone. Omit `weekdays` to run every day, or supply days from 0 (Sunday) to 6 (Saturday). A daily run more than ten minutes overdue is skipped. During daylight-saving changes, a time in a skipped hour moves forward by the gap. A repeated hour uses the first occurrence.

The schedule cursor and new run commit together. After restart, an unchanged schedule keeps its next due time. Changing the cadence, removing the schedule, or re-enabling it starts a new cadence. Scheduled runs receive the original due time in `scheduledAt`. The run page displays that time and the schedule ID.

## Receive webhook deliveries

Declare a named hook and its target profile in the latest workflow definition.

```ts
export default {
  name: 'receive-draft',
  version: 1,
  webhooks: [{ name: 'draft-intake', profile: 123 }],
  async run(request, { step }) {
    return step('Record arrival', () => ({ accepted: request.method === 'POST' }))
  },
}
```

After restarting the host, run `./buddy harness:workflow:hooks 123` on that machine. Prepend the host address to the returned path and give the URL to the sender. The path contains the hook credential. Keep it out of shared logs and protect copies of the host database. Serving only on loopback keeps ingress local. Use a reachable HTTPS address and the host's remote mode for external delivery.

GET, POST, PUT, and PATCH requests receive a run ID after the host stores the delivery. The workflow receives the method, lower-case headers, original query string without the question mark, and UTF-8 body. Harness omits credential headers and refuses bodies over 1 MiB.

A sender retry with the same delivery ID returns the original run, including after restart. Harness recognizes `X-GitHub-Delivery`, `X-Gitea-Delivery`, `X-Gitlab-Event-UUID`, `Linear-Delivery`, `Webhook-Id`, and `Idempotency-Key`. A hook can also define a `key(request)` function for its sender's format. Return a stable string, or `undefined` to use a standard delivery header. Deliveries without a stable key start separate runs. Each hook allows 60 new runs per rolling minute. A retry for an existing run still returns its ID while the hook is at capacity.

Set `HARNESS_WORKFLOW_WEBHOOKS=0` on the host and restart to block deliveries and hide hook paths from the CLI. Removing a hook definition also stops its deliveries. Run history shows the hook name.

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

A failure pauses the run with its saved steps intact. After a crash, the restarted host takes over once the previous lease expires. Cancellation is terminal. Tracker triggers, hosted webhook relay, agent steps, questions, and editing workflow definitions in the app are tracked in the parity backlog. [P31](https://github.com/stacksjs/harness/issues/41)
