/**
 * Fill a fresh install with fictional demo Libraries, Items, accounts and apps,
 * through the app's own web forms (no SQL). Used for the README screenshots.
 *
 *   DEMO_ADMIN_USER=admin DEMO_ADMIN_PASSWORD=... [SETUP_TOKEN=...] npm run seed-demo
 *
 * SETUP_TOKEN is only needed when no account exists yet (the admin is created then).
 * MCPENCODE_URL defaults to http://127.0.0.1:3000. Run it once on an empty install.
 * Demo accounts get random passwords that are not printed; reset them under Accounts.
 */
import { randomBytes } from "node:crypto";

const base = (process.env.MCPENCODE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const adminUser = process.env.DEMO_ADMIN_USER ?? "admin";
const adminPassword = process.env.DEMO_ADMIN_PASSWORD ?? "";
const setupToken = process.env.SETUP_TOKEN ?? "";
if (adminPassword.length < 12) throw new Error("Set DEMO_ADMIN_PASSWORD (12+ characters).");

type Doc = { name: string; summary: string; body: string; labels?: string; fields?: Record<string, string> };

function policy(name: string, labels: string, summary: string, fields: Record<string, string>): Doc {
  return {
    name,
    labels,
    summary,
    body: "",
    fields: { owner: "Security Lead", approved_by: "IT Director", effective_date: "2026-07-01", ...fields },
  };
}

const PASSWORD_V1 = `- Minimum 14 characters; passphrases encouraged.
- No forced periodic rotation. Reset immediately if a compromise is suspected.
- MFA on email, VPN, RMM, PSA and every admin console.
- Approved MFA: authenticator push with number matching, or a FIDO2 security key.`;

const PASSWORD_V2 = `- Minimum 16 characters; passphrases encouraged.
- No forced periodic rotation. Reset immediately if a compromise is suspected.
- MFA on email, VPN, RMM, PSA and every admin console.
- Approved MFA: FIDO2 security key or passkey. Authenticator push is allowed until 31 March.`;
type Lib = {
  name: string;
  mode: "reviewed" | "direct";
  template?: "general" | "policy" | "procedure";
  items: Doc[];
  draft?: Doc;
  archived?: Doc;
  pendingEdit?: { name: string; fields: Record<string, string> };
  readerKey?: boolean;
  /** Review-by dates relative to today, so the Review queue has realistic entries. */
  reviewIn?: Record<string, number>;
};

const jar = new Map<string, string>();
function keep(res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (value === "" || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

type Form = Record<string, string | string[]>;

function encode(form: Form): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) out.append(k, one);
  return out.toString();
}

async function request(path: string, form?: Form): Promise<Response> {
  const res = await fetch(path.startsWith("http") ? path : base + path, {
    method: form ? "POST" : "GET",
    redirect: "manual",
    headers: {
      cookie: cookie(),
      ...(form ? { "content-type": "application/x-www-form-urlencoded", origin: base } : {}),
    },
    body: form ? encode(form) : undefined,
  });
  keep(res);
  if (res.status >= 400) throw new Error(`${form ? "POST" : "GET"} ${path}: ${res.status}`);
  return res;
}

/** Follow redirects by hand so every Set-Cookie lands in the jar. */
async function follow(res: Response): Promise<Response> {
  let current = res;
  for (let i = 0; i < 10 && current.status >= 300 && current.status < 400; i++) {
    current = await request(new URL(current.headers.get("location") ?? "/", base).toString());
  }
  return current;
}

const decodeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function signIn(): Promise<string> {
  const page = await follow(await request("/login"));
  const html = await page.text();
  const hidden: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) hidden[m[1]] = decodeHtml(m[2]);
  const form: Form = { ...hidden, username: adminUser, password: adminPassword };
  if (/name="setup_code"/.test(html)) Object.assign(form, { setup_code: setupToken, password_confirm: adminPassword });
  await follow(await request("/id/authorize", form));
  const page2 = await request("/libraries/new");
  const csrf = (await page2.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("Sign-in failed (check the username, password or SETUP_TOKEN).");
  return csrf;
}

async function post(path: string, form: Form): Promise<string> {
  const res = await request(path, { ...form, csrf });
  return res.headers.get("location") ?? "";
}
const idFrom = (location: string, kind: string) => location.match(new RegExp(`/${kind}/([^/?#]+)`))?.[1] ?? "";

async function addItem(libraryId: string, doc: Doc): Promise<string> {
  const loc = await post(`/libraries/${libraryId}/items`, {
    name: doc.name,
    summary: doc.summary,
    body: doc.body,
    labels: doc.labels ?? "",
    ...doc.fields,
  });
  return idFrom(loc, "items");
}

const LIBRARIES: Lib[] = [
  {
    name: "IT Security Policies",
    mode: "reviewed",
    template: "policy",
    readerKey: true,
    items: [
      policy("Remote Access Policy", "policy, remote-access", "How Northwind IT staff and clients connect to internal systems from outside the office.", {
        version: "2.1",
        purpose: "Keep internal systems reachable for remote staff without exposing them to the internet.",
        scope: "All Northwind IT employees, contractors and managed-client staff who reach internal systems from outside a Northwind office.",
        policy: `- Connect only through the company VPN (WireGuard profile issued by the Help Desk).
- MFA is required for every VPN and RDP sign-in. SMS codes are not accepted.
- Personal devices may reach webmail and the ticket portal only, never file shares or RMM consoles.
- Sessions idle for 30 minutes are disconnected.`,
        responsibilities: "Help Desk issues and revokes VPN profiles. Managers request access for new staff.",
        exceptions: "Written approval from the Security Lead; exceptions expire after 90 days.",
      }),
      policy("Password & MFA Standard", "standard, identity", "Minimum password length, MFA methods and reset rules for staff and client accounts.", {
        version: "3.0",
        purpose: "Make account takeover hard, without rules that push people to write passwords down.",
        scope: "Every Northwind IT account and every client account Northwind administers.",
        policy: PASSWORD_V1,
        responsibilities: "Shared and service accounts live in the team password vault and are rotated when anyone with access leaves.",
      }),
      policy("Patch Management Standard", "standard, patching", "Monthly patch cycle for managed Windows, macOS and network devices.", {
        version: "1.4",
        purpose: "Close known vulnerabilities quickly while catching bad updates before they reach every client.",
        scope: "All workstations, servers and network devices under a Northwind managed-services contract.",
        policy: `| Ring | Devices | When |
| --- | --- | --- |
| Pilot | Internal IT laptops | Patch Tuesday + 1 day |
| Broad | Client workstations | Patch Tuesday + 7 days |
| Servers | Client servers | Saturday window after Broad |

Actively exploited vulnerabilities are patched within 72 hours, outside the normal cycle.`,
        exceptions: "Devices that fail twice are listed in the client's ticket with a remediation date.",
      }),
      policy("Acceptable Use Policy", "policy", "What company devices, accounts and networks may and may not be used for.", {
        version: "1.0",
        purpose: "Set clear expectations for company devices and accounts.",
        scope: "All staff and contractors using Northwind IT devices, accounts or networks.",
        policy: `- Allowed: work for Northwind IT and its clients; reasonable personal use.
- Not allowed: unapproved remote-control or file-sharing tools; turning off endpoint protection or disk encryption; sharing client data outside approved systems.`,
        references: "HR Handbook, disciplinary process.",
      }),
    ],
    draft: policy("Data Classification Standard", "standard, draft", "Four data classes and how to handle each. Draft for review.", {
      version: "0.1",
      purpose: "Give everyone one shared way to label and protect information.",
      scope: "All information Northwind IT creates or holds for clients.",
      policy: `- **Public**: approved for anyone.
- **Internal**: staff only; default for company documents.
- **Confidential**: client data, contracts, HR records.
- **Restricted**: credentials, keys, security findings.`,
    }),
    archived: policy("Legacy VPN Policy", "policy, retired", "Retired. Replaced by the Remote Access Policy.", {
      version: "1.2",
      effective_date: "2023-01-15",
      purpose: "Rules for the old IPsec VPN.",
      scope: "Remote staff, 2023.",
      policy: "The IPsec VPN was decommissioned. See the Remote Access Policy.",
    }),
    pendingEdit: { name: "Password & MFA Standard", fields: { policy: PASSWORD_V2, version: "3.1" } },
  },
  {
    name: "Help Desk Runbooks",
    mode: "reviewed",
    // General library: review-by dates are set per item. Account Lockout
    // slipped past its review; Incident Response is due next week.
    reviewIn: {
      "Account Lockout": -9,
      "Incident Response Runbook": 6,
      "VPN Troubleshooting": 90,
      "Printer Queue Reset": 90,
      "New Laptop Setup": 90,
    },
    items: [
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
    ],
  },
  {
    name: "Customer Support Playbook",
    mode: "direct",
    items: [
      {
        name: "Refund Policy",
        labels: "policy, billing",
        summary: "When agents can refund without approval, and how much.",
        body: `- Within 30 days of purchase: full refund, no approval needed.
- 31–60 days: store credit, or refund with a team lead's approval.
- Over 60 days or over $500: escalate to Billing.
- Always confirm the order number and the original payment method.`,
      },
      {
        name: "Escalation Matrix",
        labels: "process",
        summary: "Who handles what, and how fast.",
        body: `| Issue | Owner | First response |
| --- | --- | --- |
| Billing dispute | Billing team | 4 business hours |
| Outage affecting many customers | On-call engineer | 15 minutes |
| Legal or press inquiry | Support manager | Same day |
| Abusive customer | Team lead | Immediately |`,
      },
      {
        name: "Tone & Voice Guide",
        labels: "style",
        summary: "How we sound in tickets, chat and email.",
        body: `- Plain and warm. Short sentences.
- Say what you will do and when ("I've refunded the order; you'll see it in 3–5 days").
- Apologize once, specifically. No "we apologize for any inconvenience."
- Avoid jargon and internal names for systems.`,
      },
      {
        name: "Shipping Delay Reply",
        labels: "macro",
        summary: "Template reply when an order is late.",
        body: "Hi {first_name}, thanks for your patience. Your order {order_id} left our warehouse on {ship_date} and the carrier now expects delivery by {eta}. If it hasn't arrived by then, reply here and I'll send a replacement right away.",
      },
    ],
  },
  {
    name: "Course: Intro to Biology",
    mode: "direct",
    items: [
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
    ],
  },
  {
    name: "Product Docs",
    mode: "reviewed",
    items: [
      {
        name: "API Authentication",
        labels: "api",
        summary: "Bearer tokens for the public REST API.",
        body: "Send `Authorization: Bearer <token>` on every request. Tokens are created under Settings → API tokens and can be scoped read-only. Tokens never expire unless revoked; rotate them at least yearly.",
      },
      {
        name: "Rate Limits",
        labels: "api, limits",
        summary: "Requests per minute by plan, and what happens when you go over.",
        body: `| Plan | Requests / minute |
| --- | --- |
| Free | 60 |
| Team | 600 |
| Enterprise | 3,000 |

Over the limit you get \`429 Too Many Requests\` with a \`Retry-After\` header.`,
      },
      {
        name: "Webhooks",
        labels: "api, webhooks",
        summary: "Event delivery, signatures and retries.",
        body: "Each delivery is signed with HMAC-SHA256 in the `X-Signature` header. Failed deliveries are retried with backoff for 24 hours. Respond with any 2xx within 10 seconds.",
      },
      {
        name: "Release Notes 2.4",
        labels: "release-notes",
        summary: "Bulk export, faster search, deprecated v1 endpoints.",
        body: "- New: bulk CSV export for projects.\n- Faster full-text search (about 3× on large workspaces).\n- Deprecated: `/v1/reports` endpoints, removed in 3.0.",
      },
    ],
  },
  {
    name: "HR Handbook",
    mode: "reviewed",
    items: [
      {
        name: "PTO Policy",
        labels: "policy, time-off",
        summary: "Paid time off accrual, requests and carry-over.",
        body: "- 20 days per year, accrued monthly.\n- Request at least 2 weeks ahead for 3+ consecutive days.\n- Up to 5 unused days carry over to the next year.",
      },
      {
        name: "Expense Reimbursement",
        labels: "policy, finance",
        summary: "What is reimbursed and how to submit.",
        body: "Submit receipts in the expense tool within 30 days. Pre-approval is needed above $250. Meals while traveling: up to $60 per day.",
      },
      {
        name: "Remote Work Guidelines",
        labels: "policy",
        summary: "Working hours, equipment and security at home.",
        body: "Core hours 10:00–15:00 local time. Company laptop only, with disk encryption on. Use the VPN for internal systems; see the Remote Access Policy.",
      },
    ],
  },
  {
    name: "Sales Battlecards",
    mode: "direct",
    items: [
      {
        name: "Discovery Questions",
        labels: "discovery",
        summary: "Questions for the first call with a new prospect.",
        body: "1. How many endpoints and sites do you manage today?\n2. Who handles after-hours incidents?\n3. Which compliance frameworks apply (HIPAA, PCI, SOC 2)?\n4. What made you start looking now?",
      },
      {
        name: "Pricing Objections",
        labels: "objections",
        summary: "Short answers to common pricing pushback.",
        body: "- *\"It's cheaper to hire one more tech.\"* One tech doesn't cover nights, vacations or a security team.\n- *\"Per-device pricing adds up.\"* Offer the per-user bundle for teams with several devices each.",
      },
      {
        name: "Competitor: Tailspin Helpdesk",
        labels: "competitor",
        summary: "Where a fictional competitor is strong, and where we win.",
        body: "**They win on:** low entry price.\n\n**We win on:** 24/7 security monitoring, documented runbooks, and a named account engineer.",
      },
    ],
  },
];

const csrf = await signIn();

const users = [
  { username: "dana.publisher" },
  { username: "sam.reader" },
];
for (const u of users) {
  await request("/accounts", { csrf, username: u.username, password: randomBytes(18).toString("base64url") }).catch(
    (e: Error) => console.warn(`account ${u.username}: ${e.message}`),
  );
}

for (const lib of LIBRARIES) {
  const libraryId = idFrom(
    await post("/libraries", { name: lib.name, template: lib.template ?? "general", write_mode: lib.mode }),
    "libraries",
  );
  const ids: Record<string, string> = {};
  for (const doc of lib.items) ids[doc.name] = await addItem(libraryId, doc);
  if (lib.mode === "reviewed") {
    await post(`/libraries/${libraryId}/items/publish`, { item_id: Object.values(ids) });
  }
  for (const [name, days] of Object.entries(lib.reviewIn ?? {})) {
    const date = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    await post(`/items/${ids[name]}/review-by`, { review_by: date });
  }
  if (lib.archived) {
    const id = await addItem(libraryId, lib.archived);
    if (lib.mode === "reviewed") await post(`/items/${id}/publish`, {});
    await post(`/items/${id}/archive`, {});
  }
  if (lib.draft) await addItem(libraryId, lib.draft);
  if (lib.pendingEdit) {
    const doc = lib.items.find((d) => d.name === lib.pendingEdit?.name);
    await post(`/items/${ids[lib.pendingEdit.name]}`, {
      name: lib.pendingEdit.name,
      summary: doc?.summary ?? "",
      body: doc?.body ?? "",
      labels: doc?.labels ?? "",
      ...doc?.fields,
      ...lib.pendingEdit.fields,
    });
  }
  if (lib.name === "IT Security Policies") {
    await post(`/libraries/${libraryId}/access`, { username: "dana.publisher", role: "publisher" });
    await post(`/libraries/${libraryId}/access`, { username: "sam.reader", role: "reader" });
  }
  if (lib.name === "Help Desk Runbooks") {
    await post(`/libraries/${libraryId}/access`, { username: "dana.publisher", role: "publisher" });
  }
  if (lib.readerKey) await post(`/libraries/${libraryId}/reader-key`, {});
  console.log(`${lib.name}: ${lib.items.length + (lib.draft ? 1 : 0) + (lib.archived ? 1 : 0)} items`);
}

// Two web apps that registered themselves: one approved, one left waiting.
for (const host of ["app.example.com", "connector.example.net"]) {
  const res = await fetch(`${base}/id/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: host === "app.example.com" ? "Example Assistant" : "Example Connector", redirect_uris: [`https://${host}/oauth/callback`] }),
  });
  if (!res.ok) console.warn(`register ${host}: ${res.status}`);
}
await post("/apps/decide", { host: "app.example.com", decision: "approve" });
console.log("Apps: app.example.com approved, connector.example.net pending");

// A fresh install has an unclaimed, empty "Main" library; remove it so the list shows only the demo.
const MAIN = "/libraries/00000000-0000-4000-8000-000000000001";
try {
  await post(`${MAIN}/claim`, {}).catch(() => undefined);
  const html = await (await request(MAIN)).text();
  if (!html.includes('href="/items/')) await post(`${MAIN}/delete`, {});
} catch {
  // Already gone or not ours: leave it.
}
