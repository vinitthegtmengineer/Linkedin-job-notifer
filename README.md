# LinkedIn Job Notifer

This is a standalone LinkedIn-to-Telegram alert bot.

## 1) Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill:

- `BOT_TOKEN` = Telegram bot token
- `GROUP_ID` = your Telegram chat/group/channel id
- `LINKEDIN_POLL_SECONDS` = check interval (default 60)
- `MAX_ALERTS_PER_CYCLE` = max sends per check (default 5)
- `MAX_POST_AGE_HOURS` = max age filter in hours (default 24)
- `REQUIRE_REMOTE` = `1` for remote-only filtering

## 2) Edit keywords

Update `linkedin-keywords.json` with your target roles.

## 3) Run

```bash
npm start
```

Test mode (no Telegram send):

```bash
npm test
```

## Notes

- First run only bootstraps old entries and sends nothing.
- From next cycle onward, only new matching posts are sent.
- Delete `seenLinkedin.json` if you want to reset memory.

## Free 24/7 (GitHub Actions)

This repo includes `.github/workflows/linkedin-notifier.yml` to run every 5 minutes.

Setup:

1. Push this project to GitHub.
2. In GitHub repo: `Settings -> Secrets and variables -> Actions`, add:
   - `BOT_TOKEN`
   - `GROUP_ID`
3. In repo `Actions` tab, run workflow `LinkedIn Notifier (Free 24/7)` once manually.
4. After that, schedule runs every 5 minutes automatically.

Important:

- Workflow persists dedupe state in `seenLinkedin.json` by auto-commit.
- For long-term free usage with 5-minute schedule, a public repo is usually safest.
