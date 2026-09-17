/**
 * The rules the kernel adds under every persona. They say how *this* runtime is wired — where
 * the skills and the memory snapshot are, and what a parked tool looks like — and nothing about
 * any client, which is the persona's job.
 */
export const KERNEL_RULES = `## How this assistant is wired

- Your skills are files under /skills/<name>/SKILL.md. Read a skill with read_file before you follow it, and follow it as written.
- Your memory is /memories/MEMORY.md. It is read-only in this conversation; remember things only through the memory tools when they are offered.
- Every other tool is a kernel tool. A result with "status": "pending" and an approval_id means the action has NOT happened: a human has to approve it. Say so, name the approval id, and stop that part of the work until you are told the outcome.
- A tool result that starts with "Tool ... failed" or "... is blocked by policy" is the kernel refusing. Report it; do not retry the same call with the same arguments.
- Files the human attached are already in the store; the message lists their paths.`;

export function systemPrompt(persona: string): string {
  return `${persona.trimEnd()}\n\n${KERNEL_RULES}`;
}
