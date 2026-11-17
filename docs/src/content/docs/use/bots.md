---
title: Bots on your computers
description: Assign native agents to specific computers and check their task receipts.
---

The **Bots** page in this fork assigns each bot to a specific computer. Native delivery runs an installed agent there. Crosswalk delivery sends a task to an existing app agent, with that computer as a requirement. A handoff does not move a cloud service onto your computer or prove where it executes. Each task keeps a copy of its assignment and delivery route.

Open `/bots` on your Nod installation. This page works before you connect a model to Nod. The agent on the selected computer supplies its own model and uses its own account. Nod's usual chat setup remains separate.

## Connect your computers

Bots and Apps are available before you select a separate AI provider for Nod's chat. You can finish computer and Crosswalk connections from the bot console during setup.

Hermes task receipts show the final reply. Open **Agent log** when you need the full engine output to inspect a failure.

1. Select **Connect computers**.
2. Connect Desktop Commander at `https://mcp.desktopcommander.app/mcp` through the private MCP setup dialog.
3. Select the connected account.
4. Select **Add bot** and choose an online computer.
5. Select **Verify and save**.

The selected computer needs Node.js 22 or later. Native delivery also needs a supported agent executable. Desktop Commander must allow its terminal tools. Verification starts a small worker, reads its hostname and persistent identity, then closes it. It does not call a model. A disconnected computer can stay as an expected name, but it cannot receive a task until verification succeeds.

Desktop Commander's account connection belongs to this Nod installation. Tokens from another application's connector are not copied. Nod keeps its connection credential encrypted in Vault. See [Connect MCP](/connect/mcp-api-cli/).

## Available agents

| Agent                     | Task execution in this fork                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Hermes                    | Uses the installed `hermes` command and the selected local profile.                                                       |
| Muse CLI                  | Uses the installed `muse exec` command. This does not establish a connection to a Muse web account.                       |
| Claude Code               | Uses the installed `claude` command with its default permission mode.                                                     |
| Muse at muse.ai           | Receives Crosswalk handoffs through its own connected agent account.                                                      |
| Claude Duet               | Receives Crosswalk handoffs. Its account is separate from Claude Code.                                                    |
| Grok Bot and ChatGPT dots | Receive Crosswalk handoffs through their existing agent numbers.                                                          |
| Instinct                  | Receives Crosswalk handoffs after its own agent joins that service. An email address alone is not a Crosswalk connection. |

The worker discovers executable files in `~/.local/bin` and the terminal's `PATH`. On Windows it accepts native `.exe` files. It does not launch `.cmd` or `.bat` files through a shell. A missing executable appears as **Agent setup needed**.

## Connect your app agents

1. Select **Connect Crosswalk** and add `https://mcp.crosswalk.to` with an access token in the private setup dialog.
2. Create or edit a bot and select **Crosswalk handoff** for task delivery.
3. Select the connected account, an existing agent number and one of your owned private workspaces.
4. Choose the requested computer and save the assignment.

Nod shows aliases that share an agent number. It refuses ambiguous names that also belong to another number. It does not invite people, create recipients, change workspace memberships or enable schedules. Only existing agents in your own account can receive these tasks. Public workspaces and another person's private workspace are excluded.

Connect each app to Crosswalk using that app's supported setup. See Crosswalk's [Muse guide](https://crosswalk.to/agents/muse) and [Instinct guide](https://crosswalk.to/agents/instinct). The receiving app keeps its own credentials. Nod uses a separate saved connection, not a key copied from another client.

A bot can stay pending while its route is incomplete. A pending Crosswalk route never falls back to a native CLI. Handoffs allow tasks of up to 16,000 characters.

## Give a task

Select **Give task**, describe the work and its limits, then select **Send task**. The worker checks the saved computer identity before it receives the task. The prompt travels as data over private process input, not as shell command text.

Each task uses a separate private working directory. Agent accounts, browser profiles and credentials stay on the assigned computer. Existing agent approval rules remain enabled. A headless agent can refuse work that needs an interactive approval; the harness does not approve it automatically. A task stops after 15 minutes.

These tasks start only from the owner's **Send task** action. They are not model tools or new schedules. Native agents can use their host accounts and files within their own permissions. This differs from Nod's isolated browser and workspace. Crosswalk tasks wait for the receiving agent's existing check or wake mechanism. This page does not wake an app or create a polling schedule for it.

## Check and stop work

**Task receipts** shows the request, assigned computer, recorded status and agent output. **Run finished** means the native process exited successfully. It does not prove that an external action succeeded. Check the returned evidence for the requested result.

**Stop task** stops that task's native child process. Nod's main Stop action also requests stops for active native tasks. Partial work can remain. Stopping does not undo an action.

Crosswalk receipts show **Handoff queued**, **Agent claimed task** when the service provides a claim, and **Result reported**. A reported result is the receiving agent's own account of the work. It is not a verified native process result or proof of an external effect. Status checks use code and call no model.

For a handoff, **Stop task** changes the remote task title to request a stop. **Stop requested** remains until the agent reports an outcome. A remote agent may continue until it reads the change. Nod does not mark it stopped or undo its actions.

Nod holds one active or unresolved task per computer. If Nod loses a response or restarts, it holds the task as **Needs review**. **Check status** reads the original task's receipt. It never submits the task again. A lost submission response keeps the same request identifier when you select **Confirm this request**.

If no trustworthy final receipt exists, the computer remains held. Inspect its native process and private worker records before recovery. Do not create another request identifier to repeat uncertain work. Worker records live under `Nod Fleet/worker` in the account's application data on macOS and Windows, or `~/.local/state/nod-fleet/worker` on Linux.

If a Crosswalk send loses its reply, **Check status** searches only the frozen private workspace for the exact request and digest. It never sends the task again. A changed account, recipient, task body or workspace, no matching record, or multiple matches keeps the outcome unresolved. Repeated **Send task** requests with the same identifier return the saved record; a changed payload under that identifier is refused.
