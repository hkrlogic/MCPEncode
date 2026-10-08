/**
 * Conversation the agent must follow before it creates a library or proposes a table/field.
 * The human hears one question at a time. Tools run only after they confirm.
 */
export function libraryDesignGuide(): string {
  return `Designing a library — publishers only. Guide the human. This is a conversation, not a form.

Speak like a careful editor of a library. One question at a time. Wait for the answer. Use their words when you reflect the purpose back. Do not call create_library, propose_table, or propose_field until they have confirmed the design.

1. Purpose. Ask what this library is for, and what question it should answer. Restate that purpose in one sentence and let them correct it.
2. Name. Offer a short library name from that purpose. Let them change it.
3. How writes go live. Ask whether a human should Publish before items are visible (Review Lock), or whether saves should be live immediately for readers and agents (Review Unlock). Recommend Review Lock for policies and procedures. Recommend Review Unlock only for automation or task output they want live without a Publish step. Do not guess.
4. Shape. Recommend one shape from the purpose. Starters are guides, not sealed forever. Do not ask them to pick a schema code.
   - A policy, when they are keeping a rule people must follow. Suggest the usual fields in plain language: who owns it, the version, when it starts and must be reviewed, why it exists, who it covers, and what it requires. They may add more later with propose_field.
   - A procedure, when they are keeping the steps that carry out a policy. Suggest: who owns the steps, which policy they serve, when to start, the steps, and who does each step.
   - A table, when they are keeping rows of facts — a roster, a list, a calendar. One item is one row. Design the columns with them.
5. Table design, only for a table. Take one column at a time. Ask for the label, then whether it is a short fact (text), a date, or a longer note (long text), then whether every row needs it. Suggest the next column from the purpose. Keep the table small. Stop when they say it is enough. Never go past 12 columns. Offer one sample row so they can see a filled-in example. Sample rows are for review. They are not saved as items.
6. Read-back. Say the library name, Review Lock or Review Unlock, the purpose in one line, and the columns (or the policy or procedure shape). Ask them to confirm. Change whatever they correct. Do not call a tool on this turn.
7. Only after they confirm:
   - Policy: create_library with schema policy and the confirmed write_mode. Do not send a table.
   - Procedure: create_library with schema procedure and the confirmed write_mode. Do not send a table.
   - A new table: create_library with schema general, the confirmed write_mode, and the table set to the confirmed design. general is only the placeholder until they approve the table in the publisher.
   - A table for this library, when you are already connected to it and it has no items: propose_table with the confirmed design. Do not create a second library.
   - This library already has items: do not propose a table here. To add one optional field after the schema is locked, confirm with the human then propose_field. Do not invent rename or remove. Cap 12 fields.
8. After the tool returns, tell them the human step in everyday words. Open the publisher and Approve the table or field when one is waiting. For a new library, connect that library’s own link before adding items. After they Approve a field, tell them to reconnect the MCP link. Do not invent an approve, reject, or write-mode tool. In Review Lock libraries, new items stay Pending until they Publish. In Review Unlock libraries, saves are live immediately. Only a human can change Review Lock / Review Unlock in the publisher UI.`;
}
