# Known limitations (v0.1)

- **Single instance only.** Pending sign-ins, consent answers, authorization codes, and the sign-in and rate-limit counters live in the app's memory (known-good sign-in addresses are kept in Postgres). Run one app process; a second replica would not see the first one's pending sign-ins, and each would count rate limits on its own.
- **Pending sign-ins are lost on restart.** Someone in the middle of a sign-in simply starts again; issued tokens and refresh tokens survive.
- **Connect tokens are stored in plain text** in Postgres, so a Publisher can show the link again. Treat database backups as secret. Reader keys are already hashed; **hashing Connect tokens is planned for v0.2.**
- **Review Lock hides edited items.** Editing a published item (by a person or an agent) moves it back to Pending, and Readers stop seeing it until someone Publishes it again. MCP item output does not yet include the status, so an agent cannot tell. **Workaround:** Publish edits promptly, so the item is out of view only briefly. The fix is planned for v0.2.
- **`style-src` still allows `'unsafe-inline'`.** Scripts are strict (`script-src 'self'`); inline styles cannot run code but are still permitted.
- **No break-glass for the last Site admin.** If the only Site admin password is lost, recovery is through Postgres.
- **Built-in sign-in is for small teams.** No MFA yet. Use [external sign-in (OIDC)](oidc.md) when you need those.
