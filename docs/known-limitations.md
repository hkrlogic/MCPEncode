# Known limitations (v0.2)

- **Single instance only.** Pending sign-ins, consent answers, authorization codes, and the sign-in and rate-limit counters live in the app's memory (known-good sign-in addresses are kept in Postgres). Run one app process; a second replica would not see the first one's pending sign-ins, and each would count rate limits on its own.
- **Pending sign-ins are lost on restart.** Someone in the middle of a sign-in simply starts again; issued tokens and refresh tokens survive.
- **Item files are not versioned.** With Review Lock, adding or removing a file on a published Item moves it to Pending and its published text stays live, but Readers see the current file list straight away.
- **`style-src` still allows `'unsafe-inline'`.** Scripts are strict (`script-src 'self'`); inline styles cannot run code but are still permitted.
- **Revoking an app's host does not end access tokens already issued.** Refresh tokens of clients on that host are deleted at once; an access token already handed out keeps working until it expires (15 minutes).
- **No break-glass for the last Site admin.** If the only Site admin password is lost, recovery is through Postgres.
- **Built-in sign-in is for small teams.** No MFA yet. Use [external sign-in (OIDC)](oidc.md) when you need those.
