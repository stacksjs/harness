# T3 Code transport and CLI inventory

The transport identifiers below are declared at the pinned reference revision. Their owners verify behavior through the corresponding workspace, account, or device workflow. Individual builds and deployments can expose different subsets of the catalog.

## WebSocket RPC

257 distinct method names from the base and orchestration registries.

| Declared method | Owning work packages |
| --- | --- |
| [projects.listEntries](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L487) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [projects.listIgnoredFiles](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L488) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [projects.readFile](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L489) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [projects.searchContents](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L490) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [projects.searchEntries](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L491) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [projects.writeFile](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L492) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [projects.mutate](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L493) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [projects.ensureScratch](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L494) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [projects.createNew](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L495) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [projects.createFromThread](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L496) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [shell.openInEditor](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L498) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [filesystem.browse](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L500) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [workspace.listFolders](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L501) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [workspace.scanFolders](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L502) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [workspace.taskFolder](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L503) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [workspace.addTaskFolderRepository](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L504) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [filesystem.getMetadata](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L505) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [agentSessions.scan](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L506) | [P18](https://github.com/stacksjs/harness/issues/29) |
| [agentSessions.import](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L507) | [P18](https://github.com/stacksjs/harness/issues/29) |
| [assets.createUrl](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L508) | [P15](https://github.com/stacksjs/harness/issues/26), [P16](https://github.com/stacksjs/harness/issues/27) |
| [assets.persistChatAttachments](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L509) | [P15](https://github.com/stacksjs/harness/issues/26), [P16](https://github.com/stacksjs/harness/issues/27) |
| [attachments.createUploadUrl](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L510) | [P15](https://github.com/stacksjs/harness/issues/26), [P16](https://github.com/stacksjs/harness/issues/27) |
| [attachments.delete](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L511) | [P15](https://github.com/stacksjs/harness/issues/26), [P16](https://github.com/stacksjs/harness/issues/27) |
| [mcpApps.callTool](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L513) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [mcpApps.toolInfo](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L514) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [mcpApps.readResource](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L515) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [mcpApps.updateModelContext](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L516) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [provider.uploadFeedback](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L518) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [provider.mcpSignIn.start](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L519) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [provider.mcpSignIn.complete](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L520) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [provider.auth.start](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L521) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.consumeResetCredit](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L522) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [provider.auth.complete](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L523) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.chatgpt.reconnect-profile](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L524) | [P12](https://github.com/stacksjs/harness/issues/24) |
| [provider.chatgpt.import-profile](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L525) | [P12](https://github.com/stacksjs/harness/issues/24) |
| [provider.chatgpt.handoff.subscribe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L526) | [P12](https://github.com/stacksjs/harness/issues/24) |
| [provider.auth.respond](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L527) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.auth.cancel](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L528) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.auth.removeMethod](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L529) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.auth.logout](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L530) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.auth.subscribe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L531) | [P09](https://github.com/stacksjs/harness/issues/21), [P10](https://github.com/stacksjs/harness/issues/22), [P11](https://github.com/stacksjs/harness/issues/23), [P13](https://github.com/stacksjs/harness/issues/1), [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.install.start](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L532) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.install.cancel](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L533) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.install.subscribe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L534) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [provider.install.remove](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L535) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [vcs.pull](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L537) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [vcs.refreshStatus](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L538) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [vcs.listRefs](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L539) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [vcs.createWorktree](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L540) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [vcs.removeWorktree](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L541) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [vcs.createRef](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L542) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [vcs.switchRef](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L543) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [vcs.init](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L544) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [git.runStackedAction](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L546) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [git.resolvePullRequest](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L547) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [git.preparePullRequestThread](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L548) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [review.getBranchCommits](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L550) | [P20](https://github.com/stacksjs/harness/issues/31), [P22](https://github.com/stacksjs/harness/issues/33) |
| [review.getDiffPreview](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L551) | [P20](https://github.com/stacksjs/harness/issues/31), [P22](https://github.com/stacksjs/harness/issues/33) |
| [review.getDiffFileContents](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L552) | [P20](https://github.com/stacksjs/harness/issues/31), [P22](https://github.com/stacksjs/harness/issues/33) |
| [terminal.open](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L554) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [terminal.attach](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L555) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [terminal.observe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L556) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [terminal.write](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L557) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [terminal.resize](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L558) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [terminal.clear](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L559) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [terminal.close](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L560) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [preview.open](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L562) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [preview.resize](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L563) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [preview.adjust](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L564) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [preview.close](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L565) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [preview.list](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L566) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [preview.clearProfile](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L567) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [preview.reportProfiles](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L568) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [preview.reportStatus](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L569) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [preview.stopLocalServer](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L570) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [device.configure](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L572) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.list](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L573) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.testHost](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L574) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.easAccount](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L575) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.simlockIdentity](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L576) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.open](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L577) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.close](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L578) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.shutdown](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L579) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.detail](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L580) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [device.action](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L581) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [server.probe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L583) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [server.getConfig](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L584) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [server.getNpmRelease](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L585) | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40) |
| [server.refreshProviders](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L586) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [server.updateProvider](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L587) | [P09](https://github.com/stacksjs/harness/issues/21) |
| [server.updateServer](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L588) | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40) |
| [server.updateServerWithProgress](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L589) | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40) |
| [server.commitDesktopUpdate](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L590) | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40) |
| [server.upsertKeybinding](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L591) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [server.removeKeybinding](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L592) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [server.runStorageCleanup](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L593) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.getStorageCleanupReport](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L594) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.getDatabaseStorage](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L595) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.reclaimDatabaseSpace](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L596) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [peerLinks.list](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L597) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.names](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L598) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.link](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L599) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.unlink](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L600) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.answerRequest](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L601) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.subscribeThread](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L602) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.threadHistoryPage](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L603) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.threadItem](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L604) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.pairClient](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L605) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [peerLinks.pairLink](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L606) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [server.getSettings](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L607) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [server.updateSettings](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L608) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [server.discoverSourceControl](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L609) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [server.checkSecretSource](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L610) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [server.searchAcpRegistry](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L611) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.prepareAcpRegistryAgent](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L612) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.uninstallAcpRegistryManagedBinary](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L613) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.acceptAcpRegistryUrlAuth](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L614) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.listAcpRegistrySessions](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L615) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.importAcpRegistrySession](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L616) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.deleteAcpRegistrySession](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L617) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.listAcpRegistryProviders](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L618) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.setAcpRegistryProvider](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L619) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.disableAcpRegistryProvider](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L620) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.logoutAcpRegistry](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L621) | [P14](https://github.com/stacksjs/harness/issues/25) |
| [server.getTraceDiagnostics](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L622) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.getProcessDiagnostics](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L623) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.getHostResources](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L624) | [P34](https://github.com/stacksjs/harness/issues/44) |
| [server.getProcessResourceHistory](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L625) | [P34](https://github.com/stacksjs/harness/issues/44) |
| [server.getResourceTelemetryHistory](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L626) | [P34](https://github.com/stacksjs/harness/issues/44) |
| [server.retryResourceTelemetry](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L627) | [P34](https://github.com/stacksjs/harness/issues/44) |
| [server.checkOtlpEndpoint](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L628) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.listTextGeneratorModels](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L629) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.prepareTriage](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L630) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [server.signalProcess](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L631) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.reportClientActivity](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L632) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.getUsageSummary](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L633) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [server.refreshUsageRates](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L634) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [workflows.subscribe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L636) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workflows.counts](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L637) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workflows.get](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L638) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workflows.answer](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L639) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workflows.resume](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L640) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workflows.cancel](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L641) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workflows.getDefinition](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L642) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workflows.saveDefinition](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L643) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [workflows.deleteDefinition](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L644) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [scheduledTasks.subscribe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L646) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [scheduledTasks.upsert](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L647) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [scheduledTasks.setEnabled](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L648) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [scheduledTasks.delete](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L649) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [scheduledTasks.runNow](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L650) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [scheduledTasks.rotateWebhookToken](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L651) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [secrets.answerRequest](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L652) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [agentFeedback.answerRequest](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L653) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [guestShare.create](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L654) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [scheduledTasks.listWebhookDeliveries](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L655) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [scheduledTasks.getWebhookDelivery](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L656) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [cloud.getRelayClientStatus](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L658) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [cloud.installRelayClient](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L659) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [pullRequests.list](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L661) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.listStats](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L662) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.filterOptions](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L663) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.summary](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L664) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.routing](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L665) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.routingIdentity](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L666) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.stack](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L667) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.linkedThreads](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L668) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.detail](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L669) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.preview](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L670) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.checks](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L671) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.activity](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L672) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.reviewGuide](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L673) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.generateReviewGuide](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L674) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.threadComments](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L675) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.diffFileContents](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L676) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.filesViewed](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L677) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.changeBreakdown](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L678) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.setFilesViewed](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L679) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.runAction](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L680) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.update](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L681) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.comment](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L682) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.updateComment](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L683) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.submitReview](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L684) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.replyToThread](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L685) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.setThreadResolution](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L686) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.setReaction](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L687) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.invalidate](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L688) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.reportState](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L689) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.subscribeRefreshes](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L690) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.subscribeLinkedThreadRefreshes](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L691) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.reviewerCandidates](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L692) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.requestReviewers](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L693) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.labelCandidates](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L694) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [pullRequests.setLabels](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L695) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [issues.list](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L698) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.detail](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L699) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.comments](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L700) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.templates](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L701) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.candidates](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L702) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.create](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L703) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.comment](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L704) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.update](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L705) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.setState](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L706) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.react](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L707) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issues.linkedThreads](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L708) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issueTrackers.list](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L709) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issueTrackers.connect](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L710) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [issueTrackers.bindProject](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L711) | [P23](https://github.com/stacksjs/harness/issues/34) |
| [sourceControl.lookupRepository](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L713) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [sourceControl.cloneRepository](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L714) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [sourceControl.publishRepository](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L715) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [sourceControl.signInStart](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L716) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [sourceControl.signInWait](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L717) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [sourceControl.signInCancel](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L718) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [sourceControl.appAccess](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L719) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [sourceControl.starred](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L720) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [sourceControl.star](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L721) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [projectClone.start](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L722) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [projectClone.cancel](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L723) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [projectClone.retry](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L724) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [subscribeProjectClones](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L725) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [subscribeVcsStatus](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L727) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [subscribeVcsBranch](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L728) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [vcs.refreshBranch](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L729) | [P19](https://github.com/stacksjs/harness/issues/30), [P22](https://github.com/stacksjs/harness/issues/33) |
| [subscribeWorktreeSetup](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L730) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [worktreeSetup.cancel](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L731) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [subscribeTerminalMetadata](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L732) | [P21](https://github.com/stacksjs/harness/issues/32) |
| [subscribePreviewEvents](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L733) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [subscribeDiscoveredLocalServers](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L734) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [subscribeDeviceState](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L735) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [subscribeServerConfig](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L736) | [P08](https://github.com/stacksjs/harness/issues/20), [P25](https://github.com/stacksjs/harness/issues/36) |
| [subscribeServerLifecycle](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L737) | [P25](https://github.com/stacksjs/harness/issues/36), [P33](https://github.com/stacksjs/harness/issues/43) |
| [subscribeAuthAccess](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L738) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [subscribeResourceTelemetry](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/rpc.ts#L739) | [P34](https://github.com/stacksjs/harness/issues/44) |
| [orchestration.dispatchCommand](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4093) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [orchestration.getTurnDiff](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4094) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [orchestration.getFullThreadDiff](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4095) | [P20](https://github.com/stacksjs/harness/issues/31) |
| [orchestration.searchThreads](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4096) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [orchestration.searchThread](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4097) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [orchestration.searchThreadStream](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4098) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [orchestration.getArchivedShellSnapshot](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4099) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [orchestration.getThreadFamily](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4100) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [orchestration.getThreadTitles](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4101) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [orchestration.getThreadLinkMetadata](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4102) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [orchestration.getWorktreeThreadIds](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4103) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [orchestration.getOlderSettledThreads](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4104) | [P07](https://github.com/stacksjs/harness/issues/19) |
| [orchestration.getThreadProjection](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4105) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [orchestration.getWorkflowScript](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4106) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [orchestration.getNativeChildWork](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4107) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [orchestration.stopWorkflow](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4108) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [orchestration.forceStopThread](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4109) | [P17](https://github.com/stacksjs/harness/issues/28) |
| [orchestration.getTurnItem](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4110) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [orchestration.launchThread](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4111) | [P05](https://github.com/stacksjs/harness/issues/17), [P07](https://github.com/stacksjs/harness/issues/19) |
| [orchestration.subscribeShell](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4112) | [P04](https://github.com/stacksjs/harness/issues/16) |
| [orchestration.subscribeThread](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4113) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [orchestration.subscribeCommandOutput](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4114) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [orchestration.subscribePromptSuggestion](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/orchestrationV2.ts#L4115) | [P15](https://github.com/stacksjs/harness/issues/26) |

## HTTP API

55 typed endpoint declarations and 23 direct router registrations. Router constants link to their binding site.

| Method and path | Owning work packages |
| --- | --- |
| [GET /.well-known/t3/environment](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L590) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [GET /api/auth/session](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L597) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [POST /api/auth/browser-session](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L604) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [POST /oauth/token](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L611) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [POST /api/auth/websocket-ticket](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L619) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [POST /api/auth/websocket-ticket/:use](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L626) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [POST /api/auth/pairing-token](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L634) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [POST /api/auth/pairing-links/revoke](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L642) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [POST /api/auth/clients/revoke](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L650) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [POST /api/auth/connect-devices/approve](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L658) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/auth/connect-devices/revoke](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L666) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/auth/clients/revoke-others](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L674) | [P25](https://github.com/stacksjs/harness/issues/36) |
| [GET /.well-known/oauth-protected-resource](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L683) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [GET /.well-known/oauth-protected-resource/mcp](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L688) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [GET /.well-known/oauth-authorization-server](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L693) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [POST /oauth/mcp/register](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L698) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [GET /oauth/mcp/authorize](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L704) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [POST /oauth/mcp/approval](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L706) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [POST /oauth/mcp/decision](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L715) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [POST /oauth/mcp/token](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L724) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [POST /oauth/mcp/revoke](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L731) | [P32](https://github.com/stacksjs/harness/issues/42) |
| [GET /api/orchestration/shell](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L775) | [P04](https://github.com/stacksjs/harness/issues/16), [P16](https://github.com/stacksjs/harness/issues/27) |
| [GET /api/orchestration/threads/:threadId](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L783) | [P04](https://github.com/stacksjs/harness/issues/16), [P16](https://github.com/stacksjs/harness/issues/27) |
| [GET /api/orchestration/threads/:threadId/transcript](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L791) | [P04](https://github.com/stacksjs/harness/issues/16), [P16](https://github.com/stacksjs/harness/issues/27) |
| [GET /api/orchestration/threads/:threadId/bounded](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L799) | [P04](https://github.com/stacksjs/harness/issues/16), [P16](https://github.com/stacksjs/harness/issues/27) |
| [GET /api/orchestration/threads/:threadId/history](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L808) | [P04](https://github.com/stacksjs/harness/issues/16), [P16](https://github.com/stacksjs/harness/issues/27) |
| [GET /api/projects](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L819) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [POST /api/projects/mutate](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L826) | [P19](https://github.com/stacksjs/harness/issues/30) |
| [POST /api/pull-requests/diff](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L835) | [P22](https://github.com/stacksjs/harness/issues/33) |
| [GET /api/voice/cloud/keys](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L856) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/cloud/:provider/key](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L863) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [GET /api/voice/cloud/openrouter/models](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L877) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/cloud/:provider/transcribe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L884) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [GET /api/voice/status](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L900) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/models/prepare](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L907) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [GET /api/voice/models](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L914) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/models/download](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L922) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/models/select](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L930) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/models/cancel](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L938) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/models/remove](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L946) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/models/link](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L954) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/acceleration](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L962) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/model-unload-timeout](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L970) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/transcribe](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L978) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/voice/post-process](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L988) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [POST /api/connect/link-proof](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L998) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/connect/relay-config](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1006) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET /api/connect/link-state](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1014) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/connect/reachability](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1021) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/connect/unlink](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1028) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/connect/preferences](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1035) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/connect/live-activity-preference](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1043) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/t3-connect/health](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1051) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/t3-connect/mint-credential](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1058) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST /api/peer-link/client-pairing](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/packages/contracts/src/environmentHttp.ts#L1070) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET /callback](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/cloud/CliTokenManager.ts#L517) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [* `${DeviceService.DEVICE_HUB_ROUTE_PREFIX}/*`](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/device/DeviceHubProxy.ts#L270) | [P28](https://github.com/stacksjs/harness/issues/39) |
| [POST `${GUEST_ROUTE_PREFIX}/redeem`](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L108) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [POST `${GUEST_ROUTE_PREFIX}/messages`](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L181) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET `${GUEST_ROUTE_PREFIX}/stream`](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L203) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET `${GUEST_ROUTE_PREFIX}/session`](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L216) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET GUEST_RENDER_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L232) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET GUEST_ITEM_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L250) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET GUEST_HISTORY_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L269) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET GUEST_COMMAND_OUTPUT_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L291) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET GUEST_ATTACHMENT_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L307) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET GUEST_MEDIA_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/guest/http.ts#L337) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET DESKTOP_READINESS_PROOF_PATH](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/http.ts#L418) | [P27](https://github.com/stacksjs/harness/issues/38) |
| [POST OTLP_TRACES_PROXY_PATH](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/http.ts#L445) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [GET `${ASSET_ROUTE_PREFIX}/*`](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/http.ts#L526) | [P15](https://github.com/stacksjs/harness/issues/26), [P16](https://github.com/stacksjs/harness/issues/27) |
| [POST `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/http.ts#L585) | [P15](https://github.com/stacksjs/harness/issues/26), [P16](https://github.com/stacksjs/harness/issues/27) |
| [GET *](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/http.ts#L857) | [P06](https://github.com/stacksjs/harness/issues/18) |
| [GET PEER_LINK_THREAD_STREAM_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/peer/linkThreadHttp.ts#L96) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET PEER_LINK_THREAD_HISTORY_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/peer/linkThreadHttp.ts#L121) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET PEER_LINK_THREAD_ITEM_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/peer/linkThreadHttp.ts#L141) | [P26](https://github.com/stacksjs/harness/issues/37) |
| [GET PREVIEW_TUNNEL_ROUTE](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/preview/PreviewTunnel.ts#L217) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [GET SPEECH_STREAM_PATH](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/speech/stream.ts#L121) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [GET /ws](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/ws.ts#L3776) | [P04](https://github.com/stacksjs/harness/issues/16), [P25](https://github.com/stacksjs/harness/issues/36) |

## CLI command families

The registry also contains private launch, bridge, speech, and SSH helpers. Their outcomes are verified through the desktop, provider, speech, MCP, or remote workflows that call them.

| Registered family | Owning work packages |
| --- | --- |
| [help, status, doctor, trace, service](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P33](https://github.com/stacksjs/harness/issues/43) |
| [start, serve, up, pair, auth, environment, connect](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| [app](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P27](https://github.com/stacksjs/harness/issues/38) |
| [browser](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P24](https://github.com/stacksjs/harness/issues/35) |
| [project](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P05](https://github.com/stacksjs/harness/issues/17), [P19](https://github.com/stacksjs/harness/issues/30) |
| [thread, triage](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P07](https://github.com/stacksjs/harness/issues/19), [P16](https://github.com/stacksjs/harness/issues/27) |
| [feedback](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P16](https://github.com/stacksjs/harness/issues/27) |
| [workflow](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P31](https://github.com/stacksjs/harness/issues/41) |
| [install, update, uninstall](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40), [P33](https://github.com/stacksjs/harness/issues/43) |
| [theme](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P08](https://github.com/stacksjs/harness/issues/20) |
| [policy](https://github.com/pingdotgg/t3code/blob/431da7f4e55b82b386e68a9f32c543fac2efedf5/apps/server/src/binCli.ts) | [P33](https://github.com/stacksjs/harness/issues/43) |

## Released CLI help

The macOS arm64 v0.1.11 executable returned 63 distinct help pages. The global options shown across pages are `--help`, `--version`, `--wizard`, `--completions`, and `--log-level`. The table lists the other flags shown on each page. The pinned registry also contains registrations outside this help capture.

| Command | Flags from release help | Owning work packages |
| --- | --- | --- |
| `t3` | `--auto-bootstrap-project-from-cwd`, `--base-dir`, `--bootstrap-fd`, `--dev-url`, `--host`, `--lan`, `--log-websocket-events`, `--mode`, `--no-browser`, `--port`, `--tailscale-serve`, `--tailscale-serve-port` | [P33](https://github.com/stacksjs/harness/issues/43), [P25](https://github.com/stacksjs/harness/issues/36) |
| `t3 app` | `--base-dir` | [P27](https://github.com/stacksjs/harness/issues/38) |
| `t3 auth` | Global options | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth connect-device` | Global options | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth connect-device approve` | `--base-dir`, `--dev-url` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth connect-device list` | `--base-dir`, `--dev-url`, `--json` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth connect-device revoke` | `--base-dir`, `--dev-url` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth pairing` | Global options | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth pairing create` | `--base-dir`, `--base-url`, `--dev-url`, `--json`, `--label`, `--scope`, `--ttl` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth pairing list` | `--base-dir`, `--dev-url`, `--json` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth pairing revoke` | `--base-dir`, `--dev-url` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth session` | Global options | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth session issue` | `--base-dir`, `--dev-url`, `--json`, `--label`, `--scope`, `--subject`, `--token-only`, `--ttl` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth session list` | `--base-dir`, `--dev-url`, `--json` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 auth session revoke` | `--base-dir`, `--dev-url` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 browser` | Global options | [P24](https://github.com/stacksjs/harness/issues/35) |
| `t3 browser setup` | `--base-dir` | [P24](https://github.com/stacksjs/harness/issues/35) |
| `t3 connect` | `--base-dir`, `--headless` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 connect link` | `--base-dir`, `--headless`, `--publish-only` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 connect login` | `--base-dir`, `--headless` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 connect logout` | `--base-dir` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 connect publish` | `--base-dir`, `--disable` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 connect status` | `--base-dir`, `--json` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 connect unlink` | `--base-dir` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 doctor` | `--base-dir`, `--dry-run`, `--fix` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 environment` | Global options | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 environment link` | `--access`, `--base-dir`, `--dev-url`, `--from`, `--pairing-code`, `--url` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 environment list` | `--base-dir`, `--dev-url`, `--json` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 environment unlink` | `--base-dir`, `--dev-url` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 help` | Global options | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 install` | Global options | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 pair` | `--base-dir`, `--label`, `--scope`, `--tailscale`, `--tailscale-serve-port`, `--ttl` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 policy` | Global options | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 policy check` | Global options | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 policy show` | `--base-dir` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 policy templates` | `--policy` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 project` | Global options | [P05](https://github.com/stacksjs/harness/issues/17), [P19](https://github.com/stacksjs/harness/issues/30) |
| `t3 project add` | `--base-dir`, `--title` | [P05](https://github.com/stacksjs/harness/issues/17), [P19](https://github.com/stacksjs/harness/issues/30) |
| `t3 project remove` | `--base-dir`, `--force` | [P05](https://github.com/stacksjs/harness/issues/17), [P19](https://github.com/stacksjs/harness/issues/30) |
| `t3 project rename` | `--base-dir` | [P05](https://github.com/stacksjs/harness/issues/17), [P19](https://github.com/stacksjs/harness/issues/30) |
| `t3 serve` | `--base-dir`, `--bootstrap-fd`, `--dev-url`, `--host`, `--lan`, `--log-websocket-events`, `--mode`, `--no-browser`, `--port`, `--tailscale-serve`, `--tailscale-serve-port` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 service` | Global options | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 service install` | `--allow-downgrade`, `--base-dir` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 service protect` | `--base-dir`, `--undo`, `--yes` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 service restart` | `--base-dir` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 service status` | `--base-dir` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 service uninstall` | `--base-dir` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 status` | `--base-dir`, `--json` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 theme` | Global options | [P08](https://github.com/stacksjs/harness/issues/20) |
| `t3 theme clear` | `--base-dir` | [P08](https://github.com/stacksjs/harness/issues/20) |
| `t3 theme set` | `--base-dir`, `--id` | [P08](https://github.com/stacksjs/harness/issues/20) |
| `t3 theme show` | `--base-dir` | [P08](https://github.com/stacksjs/harness/issues/20) |
| `t3 thread` | Global options | [P07](https://github.com/stacksjs/harness/issues/19), [P16](https://github.com/stacksjs/harness/issues/27) |
| `t3 thread list` | `--base-dir`, `--json`, `--project` | [P07](https://github.com/stacksjs/harness/issues/19), [P16](https://github.com/stacksjs/harness/issues/27) |
| `t3 thread send` | `--base-dir`, `--json`, `--wait` | [P07](https://github.com/stacksjs/harness/issues/19), [P16](https://github.com/stacksjs/harness/issues/27) |
| `t3 thread show` | `--base-dir`, `--json`, `--messages` | [P07](https://github.com/stacksjs/harness/issues/19), [P16](https://github.com/stacksjs/harness/issues/27) |
| `t3 thread start` | `--base-dir`, `--branch`, `--json`, `--model`, `--option`, `--provider`, `--title`, `--wait`, `--worktree` | [P07](https://github.com/stacksjs/harness/issues/19), [P16](https://github.com/stacksjs/harness/issues/27) |
| `t3 trace` | Global options | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 trace summary` | `--base-dir`, `--limit`, `--since` | [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 triage` | `--agent`, `--base-dir`, `--model` | [P07](https://github.com/stacksjs/harness/issues/19), [P16](https://github.com/stacksjs/harness/issues/27) |
| `t3 uninstall` | `--base-dir`, `--yes` | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 up` | `--base-dir`, `--connect`, `--headless`, `--lan`, `--yes` | [P25](https://github.com/stacksjs/harness/issues/36), [P26](https://github.com/stacksjs/harness/issues/37), [P33](https://github.com/stacksjs/harness/issues/43) |
| `t3 update` | `--allow-downgrade`, `--base-dir`, `--channel`, `--yes` | [P29](https://github.com/stacksjs/harness/issues/3), [P30](https://github.com/stacksjs/harness/issues/40), [P33](https://github.com/stacksjs/harness/issues/43) |

Flag combinations, native bridge methods, provider variants, and end-to-end execution remain open in [P01](https://github.com/stacksjs/harness/issues/13).
