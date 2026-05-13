export const STOP_CONTINUATION_TEMPLATE = `Pause active work and stop continuation mechanisms for the current session.

This command will:
1. Stop the todo-continuation-enforcer from automatically continuing incomplete tasks
2. Cancel any active Ralph Loop
3. Pause the active boulder work for the current project with status \`paused_by_user\`

After running this command:
- The session will not auto-continue when idle
- The active work lineage remains stored for explicit \`/start-work\` resume
- Ordinary chat will not clear the paused state

Use this when you need to pause automated continuation without deleting the current work lineage.`
