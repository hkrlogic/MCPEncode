/**
 * Conversation the agent must follow before it creates a library or proposes a table/field.
 * The human hears one question at a time. Tools run only after they confirm.
 */
export function libraryDesignGuide(): string {
  return `Designing a library (publishers only) is a conversation, not a form. One question at a time; wait for the answer. Do not call create_library, propose_table, or propose_field until the human has confirmed the design.
1. Purpose: ask what it is for; restate it in one sentence.
2. Name: offer a short one from the purpose.
3. How writes go live: Review Lock (a human Publishes first; recommend for policies and procedures) or Review Unlock (saves live at once; only for automation output). Ask; do not guess.
4. Shape: a policy (owner, version, start and review dates, why, who it covers, what it requires), a procedure (owner, related policy, when to start, steps, who does each step), or a table of rows. For a table, take one column at a time (label; text, date or long text; required?), at most 12, and show one sample row.
5. Read back name, write mode, purpose and fields. Change what they correct. No tool call on this turn.
6. After they confirm: create_library (schema policy or procedure, or general with the table). For this library: propose_table only while it has no items; once it has items, propose_field for one optional field. Never rename or remove fields.
7. Then tell them the human step: Approve the table or field in the publisher; connect a new library's own link before adding items. Do not invent an approve, reject, or write-mode tool.`;
}
