# Before the first patient

ADR 0033. Each line gets a date and a link to its evidence when it is done. The first patient is treated only when every line is done.

| # | Gate | Evidence | Done |
| --- | --- | --- | --- |
| 1 | External penetration test, high findings fixed | | |
| 2 | Privacy impact assessment | | |
| 3 | Live Parchment connection | | |
| 4 | Backup restored into a fresh database and checked (time taken written down) | | |
| 5 | Load test at the first tenant's expected volumes, plus a spike | | |
| 6 | Clerk production instance, staff sign-up closed, a second factor required for every staff member (ADR 0220) | | |
| 7 | SPF, DKIM and DMARC on every sending domain; bounce handling; SMS sender ids | | |
| 8 | Two-factor sign-in and an access review on every console that reaches production | | |
| 9 | Each AI agent passed its eval set, has a spending cap, starts switched off | | |
| 10 | Breach response plan and a named person to run it | | |
| 11 | Data processing agreement and security review for every provider in `docs/providers.md` | | |
| 12 | Staging has run the release for at least a week with deploy checks green | | |
