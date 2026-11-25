# Pinned T3 Code reference inventory

This index maps files at [T3 Code `431da7f`](https://github.com/pingdotgg/t3code/tree/431da7f4e55b82b386e68a9f32c543fac2efedf5) to the GitHub tickets responsible for reproducing and verifying their workflows. The first ticket in a row owns its evidence. The released behavior reference is [v0.1.11](https://github.com/pingdotgg/t3code/releases/tag/v0.1.11).

The four tables cover 222 pinned files. File coverage records ownership, while the [Harness evidence matrix](harness-parity.md) records execution and results. A contribution listed in several tables shares its workflow under the same ticket. Mobile rows also require the relevant installed-client evidence through P28.

The web root and chat routes share the workspace shell. The Settings parent owns the modal and scope chooser, while its child rows own the exposed controls. The thread and project link routes share their destination workflows. The mobile source-control file bundles several screen implementations. The FAQ and the contract barrel point to coverage without introducing a separate user workflow.

## Web route files

Rendered route, alias, or shared route wrapper.

| Reference file | Owning work packages |
| --- | --- |
| [__root.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/__root.tsx) | [P06](https://github.com/stacksjs/harness/issues/18) |
| [_chat.$environmentId.$threadId.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.%24environmentId.%24threadId.tsx) | [P16](https://github.com/stacksjs/harness/issues/27), [P06](https://github.com/stacksjs/harness/issues/18), [P15](https://github.com/stacksjs/harness/issues/26), [P17](https://github.com/stacksjs/harness/issues/28) |
| [_chat.draft.$draftId.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.draft.%24draftId.tsx) | [P15](https://github.com/stacksjs/harness/issues/26) |
| [_chat.index.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.index.tsx) | [P05](https://github.com/stacksjs/harness/issues/17) |
| [_chat.issues.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.issues.tsx) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [_chat.linked.$viaEnvironmentId.$linkedEnvironmentId.$linkedThreadId.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.linked.%24viaEnvironmentId.%24linkedEnvironmentId.%24linkedThreadId.tsx) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [_chat.new.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.new.tsx) | [P05](https://github.com/stacksjs/harness/issues/17) |
| [_chat.pull-requests.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.pull-requests.tsx) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [_chat.settings.about.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.about.tsx) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [_chat.settings.access.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.access.tsx) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [_chat.settings.appearance.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.appearance.tsx) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [_chat.settings.archived.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.archived.tsx) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [_chat.settings.beta.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.beta.tsx) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [_chat.settings.browser.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.browser.tsx) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [_chat.settings.chat.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.chat.tsx) | [P08](https://github.com/stacksjs/harness/issues/20), [P15](https://github.com/stacksjs/harness/issues/26), [P16](https://github.com/stacksjs/harness/issues/27), [P17](https://github.com/stacksjs/harness/issues/28) |
| [_chat.settings.connections.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.connections.tsx) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [_chat.settings.devices.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.devices.tsx) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [_chat.settings.diagnostics.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.diagnostics.tsx) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [_chat.settings.diffs.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.diffs.tsx) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [_chat.settings.general.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.general.tsx) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [_chat.settings.integrations.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.integrations.tsx) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [_chat.settings.keybindings.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.keybindings.tsx) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [_chat.settings.labs.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.labs.tsx) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [_chat.settings.maintenance.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.maintenance.tsx) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [_chat.settings.open-source-licenses.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.open-source-licenses.tsx) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [_chat.settings.projects.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.projects.tsx) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [_chat.settings.providers.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.providers.tsx) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P12](https://github.com/stacksjs/harness/issues/24), [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [_chat.settings.scheduled-tasks.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.scheduled-tasks.tsx) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [_chat.settings.secrets.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.secrets.tsx) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [_chat.settings.snap-shot.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.snap-shot.tsx) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [_chat.settings.source-control.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.source-control.tsx) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [_chat.settings.storage.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.storage.tsx) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [_chat.settings.threads.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.threads.tsx) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [_chat.settings.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.tsx) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [_chat.settings.voice.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.voice.tsx) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [_chat.settings.worktrees.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.settings.worktrees.tsx) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [_chat.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.tsx) | [P06](https://github.com/stacksjs/harness/issues/18) |
| [_chat.usage.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.usage.tsx) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [_chat.workflows.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/_chat.workflows.tsx) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [approve-agent.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/approve-agent.tsx) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [connect-agent.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/connect-agent.tsx) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [connect.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/connect.tsx) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [guest.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/guest.tsx) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [pair.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/pair.tsx) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [projects.$projectKey.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/projects.%24projectKey.tsx) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [threads.$environmentId.$threadId.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/threads.%24environmentId.%24threadId.tsx) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [welcome.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/web/src/routes/welcome.tsx) | [P05](https://github.com/stacksjs/harness/issues/17) |

## User guides

Documented workflow or capability.

| Reference file | Owning work packages |
| --- | --- |
| [activity-log.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/activity-log.md) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [appearance.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/appearance.md) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [background-service.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/background-service.md) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [browser-import.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/browser-import.md) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [composer.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/composer.md) | [P15](https://github.com/stacksjs/harness/issues/26) |
| [cursor.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/cursor.md) | [P13](https://github.com/stacksjs/harness/issues/1) |
| [default-browser.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/default-browser.md) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [devices.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/devices.md) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [faq.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/faq.md) | [P01](https://github.com/stacksjs/harness/issues/13) |
| [guest-links.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/guest-links.md) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [html-renders.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/html-renders.md) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [install.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/install.md) | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40) |
| [keybindings.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/keybindings.md) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [keyboard-focus.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/keyboard-focus.md) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [managed-policy.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/managed-policy.md) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [mobile-notifications.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/mobile-notifications.md) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [multi-repo-projects.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/multi-repo-projects.md) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [open-source-licenses.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/open-source-licenses.md) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [outside-agents.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/outside-agents.md) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [permission-modes.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/permission-modes.md) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [portable-handoffs.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/portable-handoffs.md) | [P18](https://github.com/stacksjs/harness/issues/29) |
| [project-settings.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/project-settings.md) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [prompt-links.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/prompt-links.md) | [P15](https://github.com/stacksjs/harness/issues/26) |
| [providers-acp.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-acp.md) | [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [providers-antigravity.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-antigravity.md) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [providers-claude.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-claude.md) | [P10](https://github.com/stacksjs/harness/issues/22) |
| [providers-codex.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-codex.md) | [P11](https://github.com/stacksjs/harness/issues/23), [P12](https://github.com/stacksjs/harness/issues/24) |
| [providers-fx.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-fx.md) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [providers-kiro.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-kiro.md) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [providers-muse.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-muse.md) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [providers-opencode.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-opencode.md) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [providers-pi.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/providers-pi.md) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [question-attachments.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/question-attachments.md) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [remote-access.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/remote-access.md) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [secrets-1password-connect.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/secrets-1password-connect.md) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [secrets-1password-service-account.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/secrets-1password-service-account.md) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [secrets.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/secrets.md) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [snap-shot.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/snap-shot.md) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [source-control.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/source-control.md) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [t3-connect-troubleshooting.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/t3-connect-troubleshooting.md) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [telemetry.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/telemetry.md) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [terminal.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/terminal.md) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [text-generation.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/text-generation.md) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [thread-migration.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/thread-migration.md) | [P18](https://github.com/stacksjs/harness/issues/29) |
| [thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/thread-sidebar.md) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [triage.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/triage.md) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [updating.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/updating.md) | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40) |
| [usage.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/usage.md) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [voice-input.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/voice-input.md) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [welcome-page.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/welcome-page.md) | [P05](https://github.com/stacksjs/harness/issues/17) |
| [workflows.md](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/docs/user/workflows.md) | [P31](https://github.com/stacksjs/harness/issues/41) |

## Mobile screen implementations

Installed iOS and Android verification for each owning workflow.

| Reference file | Owning work packages |
| --- | --- |
| [ArchivedThreadsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx) | [P07](https://github.com/stacksjs/harness/issues/19), [P28](https://github.com/stacksjs/harness/issues/39) |
| [BrowserPreviewRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/browser/BrowserPreviewRouteScreen.tsx) | [P24](https://github.com/stacksjs/harness/issues/35), [P28](https://github.com/stacksjs/harness/issues/39) |
| [LocalPreviewRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/browser/LocalPreviewRouteScreen.tsx) | [P24](https://github.com/stacksjs/harness/issues/35), [P28](https://github.com/stacksjs/harness/issues/39) |
| [ConnectOnboardingRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/cloud/ConnectOnboardingRouteScreen.tsx) | [P26](https://github.com/stacksjs/harness/issues/37), [P28](https://github.com/stacksjs/harness/issues/39) |
| [ConnectionsNewRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx) | [P26](https://github.com/stacksjs/harness/issues/37), [P28](https://github.com/stacksjs/harness/issues/39) |
| [ConnectionsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/connection/ConnectionsRouteScreen.tsx) | [P26](https://github.com/stacksjs/harness/issues/37), [P28](https://github.com/stacksjs/harness/issues/39) |
| [DevicePreviewRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/devices/DevicePreviewRouteScreen.tsx) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsDiagnosticsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/diagnostics/SettingsDiagnosticsRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [ThreadFilesRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx) | [P20](https://github.com/stacksjs/harness/issues/31), [P28](https://github.com/stacksjs/harness/issues/39) |
| [HomeRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/home/HomeRouteScreen.tsx) | [P07](https://github.com/stacksjs/harness/issues/19), [P28](https://github.com/stacksjs/harness/issues/39) |
| [IssueRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/issues/IssueRouteScreen.tsx) | [P23](https://github.com/stacksjs/harness/issues/34), [P28](https://github.com/stacksjs/harness/issues/39) |
| [PullRequestRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx) | [P22](https://github.com/stacksjs/harness/issues/33), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsAboutRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsAppearanceRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsAppearanceRouteScreen.tsx) | [P08](https://github.com/stacksjs/harness/issues/20), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsAuthRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsAuthRouteScreen.tsx) | [P25](https://github.com/stacksjs/harness/issues/36), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsClientStorageRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsClientStorageRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsEnvironmentDetailRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx) | [P26](https://github.com/stacksjs/harness/issues/37), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsEnvironmentsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx) | [P26](https://github.com/stacksjs/harness/issues/37), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsFollowUpRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsFollowUpRouteScreen.tsx) | [P17](https://github.com/stacksjs/harness/issues/28), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsKeyboardRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsKeyboardRouteScreen.tsx) | [P08](https://github.com/stacksjs/harness/issues/20), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsLanguageRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsLanguageRouteScreen.tsx) | [P08](https://github.com/stacksjs/harness/issues/20), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsLegalRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsLegalRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsNavigationRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsNavigationRouteScreen.tsx) | [P08](https://github.com/stacksjs/harness/issues/20), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsNotificationsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsOpenSourceLicensesRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsOpenSourceLicensesRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsProjectGroupingRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsProjectGroupingRouteScreen.tsx) | [P07](https://github.com/stacksjs/harness/issues/19), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsProjectOverviewRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsProjectOverviewRouteScreen.tsx) | [P19](https://github.com/stacksjs/harness/issues/30), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsProviderAccountsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsProviderAccountsRouteScreen.tsx) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P12](https://github.com/stacksjs/harness/issues/24), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsRouteScreen.tsx) | [P08](https://github.com/stacksjs/harness/issues/20), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsScheduledTasksRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx) | [P31](https://github.com/stacksjs/harness/issues/41), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsServerControlsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsSourceControlDetailRouteScreens.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsSourceControlDetailRouteScreens.tsx) | [P22](https://github.com/stacksjs/harness/issues/33), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsVoiceModelsRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsVoiceModelsRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsVoiceRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/SettingsVoiceRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [SettingsLegalDocumentRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/components/SettingsLegalDocumentRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [ThreadTerminalRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx) | [P21](https://github.com/stacksjs/harness/issues/32), [P28](https://github.com/stacksjs/harness/issues/39) |
| [NewTaskDraftRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/threads/NewTaskDraftRouteScreen.tsx) | [P15](https://github.com/stacksjs/harness/issues/26), [P28](https://github.com/stacksjs/harness/issues/39) |
| [NewTaskRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/threads/NewTaskRouteScreen.tsx) | [P05](https://github.com/stacksjs/harness/issues/17), [P07](https://github.com/stacksjs/harness/issues/19), [P28](https://github.com/stacksjs/harness/issues/39) |
| [ThreadRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/threads/ThreadRouteScreen.tsx) | [P16](https://github.com/stacksjs/harness/issues/27), [P17](https://github.com/stacksjs/harness/issues/28), [P28](https://github.com/stacksjs/harness/issues/39) |
| [UsageRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/usage/UsageRouteScreen.tsx) | [P33](https://github.com/stacksjs/harness/issues/43), [P28](https://github.com/stacksjs/harness/issues/39) |
| [WorkflowRunRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/workflows/WorkflowRunRouteScreen.tsx) | [P31](https://github.com/stacksjs/harness/issues/41), [P28](https://github.com/stacksjs/harness/issues/39) |

## Public contract modules

Transport or schema fixture, plus the behavior it supports.

| Reference file | Owning work packages |
| --- | --- |
| [acpRegistry.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/acpRegistry.ts) | [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [agentFeedback.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/agentFeedback.ts) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [agentSessions.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/agentSessions.ts) | [P18](https://github.com/stacksjs/harness/issues/29) |
| [applicationEvent.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/applicationEvent.ts) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [assets.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/assets.ts) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [assistantCitations.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/assistantCitations.ts) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [auth.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/auth.ts) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [background.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/background.ts) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [baseSchemas.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/baseSchemas.ts) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [browserImport.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/browserImport.ts) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [browserProfile.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/browserProfile.ts) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [chatAttachment.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/chatAttachment.ts) | [P15](https://github.com/stacksjs/harness/issues/26) |
| [checkpointDiff.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/checkpointDiff.ts) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [clientRpcPermissions.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/clientRpcPermissions.ts) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [composerContext.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/composerContext.ts) | [P15](https://github.com/stacksjs/harness/issues/26) |
| [composerContextClipboard.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/composerContextClipboard.ts) | [P15](https://github.com/stacksjs/harness/issues/26) |
| [desktopAppActivation.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/desktopAppActivation.ts) | [P27](https://github.com/stacksjs/harness/issues/38) |
| [desktopBootstrap.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/desktopBootstrap.ts) | [P27](https://github.com/stacksjs/harness/issues/38) |
| [desktopBrowser.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/desktopBrowser.ts) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [device.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/device.ts) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [editor.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/editor.ts) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [environment.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environment.ts) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [environmentHttp.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [filesystem.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/filesystem.ts) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [git.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/git.ts) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [guestShare.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/guestShare.ts) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [guestStream.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/guestStream.ts) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [index.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/index.ts) | [P01](https://github.com/stacksjs/harness/issues/13) |
| [ipc.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/ipc.ts) | [P27](https://github.com/stacksjs/harness/issues/38) |
| [issue.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/issue.ts) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [keybindings.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/keybindings.ts) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [managedPolicy.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/managedPolicy.ts) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [mcpApps.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/mcpApps.ts) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [milestones.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/milestones.ts) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [model.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/model.ts) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [modelSelection.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/modelSelection.ts) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [orchestrationDispatch.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationDispatch.ts) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [orchestrationProject.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationProject.ts) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [orchestrationV2.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [orchestrationV2IdTable.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2IdTable.ts) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [orchestratorMcp.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestratorMcp.ts) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [peerLink.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/peerLink.ts) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [preview.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/preview.ts) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [previewAutomation.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/previewAutomation.ts) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [previewCapture.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/previewCapture.ts) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [project.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/project.ts) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [projectClone.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/projectClone.ts) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [provider.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/provider.ts) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [providerInstance.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/providerInstance.ts) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [providerPolicy.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/providerPolicy.ts) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [providerRuntime.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/providerRuntime.ts) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [providerSetup.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/providerSetup.ts) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [providerUsageLimits.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/providerUsageLimits.ts) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [pullRequest.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/pullRequest.ts) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequestReviewGuide.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/pullRequestReviewGuide.ts) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [relay.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/relay.ts) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [relayClient.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/relayClient.ts) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [remoteAccess.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/remoteAccess.ts) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [resourceTelemetry.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/resourceTelemetry.ts) | [P34](https://github.com/stacksjs/harness/issues/44) |
| [review.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/review.ts) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [rpc.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [scheduledTask.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/scheduledTask.ts) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [secretReference.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/secretReference.ts) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [secretRequest.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/secretRequest.ts) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [server.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/server.ts) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [settings.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/settings.ts) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [settingsSecretValue.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/settingsSecretValue.ts) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [sourceControl.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/sourceControl.ts) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [speech.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/speech.ts) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [t3ProjectFile.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/t3ProjectFile.ts) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [terminal.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/terminal.ts) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [threadMetadataMcp.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/threadMetadataMcp.ts) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [threadPullRequest.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/threadPullRequest.ts) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [threadSearch.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/threadSearch.ts) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [threadTags.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/threadTags.ts) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [threadTitle.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/threadTitle.ts) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [usage.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/usage.ts) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [usageLimitSourceId.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/usageLimitSourceId.ts) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [vcs.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/vcs.ts) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [workflow.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/workflow.ts) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workspaceFolders.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/workspaceFolders.ts) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [worktreeMcp.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/worktreeMcp.ts) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [worktreeSetup.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/worktreeSetup.ts) | [P19](https://github.com/stacksjs/harness/issues/30) |

## Other entry points

| Reference file | Surface | Owning work packages |
| --- | --- | --- |
| [rootNavigation.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/lib/rootNavigation.ts) | Root screen destinations and native back | [P28](https://github.com/stacksjs/harness/issues/39) |
| [navigation-tabs.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/layout/workspace/navigation-tabs.ts) | Bottom navigation and workspace tabs | [P28](https://github.com/stacksjs/harness/issues/39) |
| [settings-navigation.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/mobile/src/features/settings/settings-navigation.ts) | Settings destination registration | [P08](https://github.com/stacksjs/harness/issues/20), [P28](https://github.com/stacksjs/harness/issues/39) |
| [DesktopApplicationMenu.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/desktop/src/window/DesktopApplicationMenu.ts) | Desktop application menus | [P27](https://github.com/stacksjs/harness/issues/38) |
| [ElectronMenu.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/desktop/src/electron/ElectronMenu.ts) | Menu callbacks and native roles | [P27](https://github.com/stacksjs/harness/issues/38), [P08](https://github.com/stacksjs/harness/issues/20) |
| [preload.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/desktop/src/preload.ts) | Desktop client bridge | [P27](https://github.com/stacksjs/harness/issues/38) |
| [http.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/auth/http.ts) | Device and host HTTP authentication | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37) |
| [RpcAuthorization.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/auth/RpcAuthorization.ts) | RPC authorization and capability checks | [P25](https://github.com/stacksjs/harness/issues/36), [P04](https://github.com/stacksjs/harness/issues/16) |
| [mcpOAuthHttp.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/auth/mcpOAuthHttp.ts) | MCP connector callbacks | [P32](https://github.com/stacksjs/harness/issues/42) |
| [linkThreadHttp.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/peer/linkThreadHttp.ts) | HTTP links between peers | [P26](https://github.com/stacksjs/harness/issues/37) |
| [McpHttpServer.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/mcp/McpHttpServer.ts) | External agent and MCP HTTP transport | [P32](https://github.com/stacksjs/harness/issues/42) |
| [rpc.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts) | Public RPC catalog and event subscriptions | [P04](https://github.com/stacksjs/harness/issues/16), [P25](https://github.com/stacksjs/harness/issues/36) |
| [binCli.ts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | Public CLI command registration | [P33](https://github.com/stacksjs/harness/issues/43) |

The [transport and CLI inventory](t3-code-transport-index.md) maps individual HTTP and WebSocket declarations. The entry-point review remains open for native bridge methods, flag combinations, and integration scenarios. Each needs an outcome and evidence linked from its owning ticket before [P01](https://github.com/stacksjs/harness/issues/13) can close.
