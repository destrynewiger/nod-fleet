---
title: Bots on your computers
description: Assign native agents to specific computers and check their task receipts.
---

The **Bots** page in this fork assigns each bot to a specific computer. A bot has a name, an agent, a computer identity and an optional Hermes profile. A task keeps a copy of that assignment. Changing a bot later does not move an existing task.

Open `/bots` on your Nod installation. This page works before you connect a model to Nod. The agent on the selected computer supplies its own model and uses its own account. Nod's usual chat setup remains separate.

## Connect your computers

1. Select **Connect computers**.
2. Connect Desktop Commander at `https://mcp.desktopcommander.app/mcp` through the private MCP setup dialog.
3. Select the connected account.
4. Select **Add bot** and choose an online computer.
5. Select **Verify and save**.

The selected computer needs Node.js 22 or later and a supported agent executable. Desktop Commander must allow its terminal tools. The verification starts a small native worker, reads its hostname and persistent identity, then closes it. It does not call a model. A disconnected computer can stay as an expected name, but it cannot receive a task until verification succeeds.

Desktop Commander's account connection belongs to this Nod installation. Tokens from another application's connector are not copied. Nod keeps its connection credential encrypted in Vault. See [Connect MCP](/connect/mcp-api-cli/).

## Available agents

| Agent                            | Task execution in this fork                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Hermes                           | Uses the installed `hermes` command and the selected local profile.                                                     |
| Muse CLI                         | Uses the installed `muse exec` command. This does not establish a connection to a Muse web account.                     |
| Claude Code                      | Uses the installed `claude` command with its default permission mode.                                                   |
| Muse at muse.ai                  | Saves an assignment and opens the service. Automatic task delivery is not implemented.                                  |
| Claude Duet                      | Saves an assignment and opens the service. It is separate from Claude Code. Automatic task delivery is not implemented. |
| Grok Bot, ChatGPT dots, Instinct | Saves an assignment. These products need their own supported task connections before they can run here.                 |

The worker discovers executable files in `~/.local/bin` and the terminal's `PATH`. On Windows it accepts native `.exe` files. It does not launch `.cmd` or `.bat` files through a shell. A missing executable appears as **Agent setup needed**.

An assignment to a cloud or email service does not move that service onto the named computer. The page does not report those assignments as ready to execute.

## Give a task

Select **Give task**, describe the work and its limits, then select **Send task**. The worker checks the saved computer identity before it receives the task. The prompt travels as data over private process input, not as shell command text.

Each task uses a separate private working directory. Agent accounts, browser profiles and credentials stay on the assigned computer. Existing agent approval rules remain enabled. A headless agent can refuse work that needs an interactive approval; the harness does not approve it automatically. A task stops after 15 minutes.

These tasks start only from the owner's **Send task** action. They are not model tools, schedules or automatic background work. Native agents can use their host accounts and files within their own permissions. This differs from Nod's isolated browser and workspace.

## Check and stop work

**Task receipts** shows the request, assigned computer, recorded status and agent output. **Run finished** means the native process exited successfully. It does not prove that an external action succeeded. Check the returned evidence for the requested result.

**Stop task** stops that task's native child process. Nod's main Stop action also requests stops for active native tasks. Partial work can remain. Stopping does not undo an action.

Only one active or unresolved native task can use a computer at a time. If Nod loses a response or restarts, it holds the task as **Needs review**. **Check status** reads the original task's receipt. It never submits the task again. A lost submission response keeps the same request identifier when you select **Confirm this request**.

If no trustworthy final receipt exists, the computer remains held. Inspect its native process and private worker records before recovery. Do not create another request identifier to repeat uncertain work. Worker records live under `Nod Fleet/worker` in the account's application data on macOS and Windows, or `~/.local/state/nod-fleet/worker` on Linux.
