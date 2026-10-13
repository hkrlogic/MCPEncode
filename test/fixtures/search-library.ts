/**
 * Demo runbooks and course material (copied from scripts/seed-demo.ts), used to
 * reproduce the search-recall misses from the validation run in #30.
 */
export type FixtureItem = { name: string; labels: string; summary: string; body: string };

export const HELP_DESK_RUNBOOKS: FixtureItem[] = [
      {
        name: "Incident Response Runbook",
        labels: "runbook, security",
        summary: "First hour of a suspected security incident: contain, preserve, notify.",
        body: `## First 15 minutes
1. Open a P1 ticket and page the on-call engineer.
2. Isolate the affected device from the network through the EDR console. Do not power it off.
3. Disable the affected user's sessions and reset their password.

## First hour
- Preserve logs: EDR timeline, firewall, Microsoft 365 sign-in logs.
- Notify the Security Lead and the client's primary contact.
- Keep a timestamped log of every action in the ticket.

## Escalation
Ransomware or data exfiltration: call the incident retainer (number in the vault).`,
      },
      {
        name: "VPN Troubleshooting",
        labels: "runbook, vpn",
        summary: "Fixes for the most common VPN connection problems, in order.",
        body: `1. Confirm the user has internet access without the VPN.
2. Check that the WireGuard profile is current (Help Desk portal → Devices).
3. Restart the WireGuard service; on Windows, \`Restart-Service WireGuardTunnel*\`.
4. Hotel or guest Wi-Fi blocking UDP 51820: switch to the TCP fallback profile.
5. Still failing: collect the client log and escalate to Network Tier 2.`,
      },
      {
        name: "New Laptop Setup",
        labels: "runbook, onboarding",
        summary: "Provisioning a new staff laptop from box to handover in about 45 minutes.",
        body: `1. Enroll the device in Intune/Autopilot with the client's tag.
2. Sign in as the user; confirm BitLocker or FileVault is on.
3. Install the RMM agent and EDR, then check both report in.
4. Map printers and confirm the VPN profile connects.
5. Hand over with the one-page quick start and book a 15-minute follow-up.`,
      },
      {
        name: "Account Lockout",
        labels: "runbook, identity",
        summary: "Verify identity and unlock a locked-out user without weakening security.",
        body: `1. Verify the caller with a callback to the number on file. Never unlock on an inbound call alone.
2. Check sign-in logs for failed attempts from unknown locations.
3. Unknown locations: treat as a possible compromise and follow the Incident Response Runbook.
4. Otherwise unlock, require a password reset at next sign-in, and note it in the ticket.`,
      },
      {
        name: "Printer Queue Reset",
        labels: "runbook, printing",
        summary: "Clear a stuck Windows print queue.",
        body: "1. `Stop-Service Spooler`\n2. Delete files in `C:\\Windows\\System32\\spool\\PRINTERS`.\n3. `Start-Service Spooler` and print a test page.",
      },
    ];

export const INTRO_BIOLOGY: FixtureItem[] = [
      {
        name: "Unit 3 Lesson Plan: Cell Structure",
        labels: "lesson-plan, unit-3",
        summary: "Three 50-minute lessons on prokaryotic and eukaryotic cells.",
        body: `## Objectives
Students can label the main organelles and explain how prokaryotic and eukaryotic cells differ.

## Lessons
1. Cell theory and microscope basics (onion skin lab).
2. Organelles: structure and function (card sort).
3. Comparing cells: Venn diagram and exit ticket.

## Materials
Microscopes, prepared slides, organelle cards, worksheet 3.1.`,
      },
      {
        name: "Lab Report Rubric",
        labels: "rubric, grading",
        summary: "How lab reports are scored (20 points).",
        body: `| Section | Points |
| --- | --- |
| Hypothesis is testable | 3 |
| Method can be repeated | 4 |
| Data table and graph | 5 |
| Analysis uses the data | 5 |
| Spelling, units and citations | 3 |`,
      },
      {
        name: "Approved Reading List",
        labels: "reading",
        summary: "Supplementary readings students may cite.",
        body: "- Course textbook, chapters 3–6\n- Open-access biology textbook (school library portal)\n- Class handouts posted in the LMS\n\nOther sources need teacher approval before citing.",
      },
      {
        name: "Homework & Late Work Policy",
        labels: "policy",
        summary: "Due dates, late penalties and AI-assistant rules.",
        body: "- Homework is due at the start of class.\n- Late work: 10% off per school day, up to 3 days.\n- AI assistants may explain concepts, but answers must be in your own words; note any AI help at the end.",
      },
    ];
