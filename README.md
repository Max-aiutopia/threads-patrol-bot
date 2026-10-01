# Threads Patrol Bot

A LINE bot that helps one person reply to Threads posts in a consistent voice, without automating the posting itself.

You paste a Threads post URL into LINE (plus the post text or a screenshot). Claude writes five comment drafts in the persona you pick. Each draft comes with a link that opens the Threads reply box with the text already filled in, and you decide whether to post it. A small dashboard tracks your account growth and how each comment performed.

[中文說明在下面](#中文說明)

## What it does

- **Drafts in a persona.** Personas only set tone (straight-talking consultant, friendly banter, gentle coach). Only one persona is allowed to carry a real identity, and its facts come from a fixed source.
- **A human posts every comment.** The bot never posts on your behalf. A `/go/<id>` link checks the safety rules first, then redirects to the Threads reply intent.
- **Safety rules run before each comment opens:**
  - daily and hourly caps, with a lower cap in the first 14 days
  - a quiet window at night
  - a cooldown per author, plus a blocklist
  - randomized spacing between comments
  - a limit on how often a product gets mentioned
  - a similarity check against your last 200 comments (Dice coefficient on character bigrams)
- **Tracking on a schedule:**
  - hourly: matches drafts to the comments you actually posted and pulls their metrics
  - daily: account snapshots
  - every morning: a report pushed to LINE
  - weekly: token refresh and data retention cleanup
- **Dashboard:** a password-protected web page for growth and per-comment results.

## Stack

| Part | Choice |
|---|---|
| Runtime | Cloudflare Workers (TypeScript, no framework), designed to fit the free plan's per-invocation limits |
| Data | Cloudflare D1 (SQLite), 3 migrations |
| Background work | Cloudflare Queues + Cron Triggers |
| AI | Claude API (`@anthropic-ai/sdk`, the only runtime dependency) |
| Messaging | LINE Messaging API (webhook, reply/push, Flex messages) |
| Social data | Official Threads API (OAuth, insights) |

About 6,800 lines of TypeScript in `src/`.

## Security

- LINE webhook requests are verified with HMAC-SHA256 and a timing-safe compare.
- Threads access tokens are stored encrypted with AES-256-GCM.
- The dashboard uses a signed session cookie, a password of at least 12 characters, login rate limiting and CSRF protection.
- Duplicate LINE webhook events are processed only once.
- Push messages carry a retry key so a retried request isn't delivered twice.
- Meta's deauthorize and data-deletion callbacks only remove the requesting user's data.

## Tests

```bash
npm install
npm test            # 232 unit tests (Vitest)
npm run test:e2e    # 18 end-to-end scenarios against mock LINE / Threads / Claude servers
```

The end-to-end suite runs the real Worker with `wrangler dev` against a local mock server. It covers signature checks, duplicate events, the `/go/` safety rules, dashboard login limits and CSRF, Threads OAuth with token encryption, a Claude 500 followed by one retry, queue jobs and the Meta deletion flow.

## Try it locally without any accounts

```bash
npm install
npm run demo        # mock LINE / Threads / Claude + wrangler dev, costs nothing
```

## Deploy your own

1. `npx wrangler d1 create patrol-db`, then put the `database_id` into `wrangler.jsonc`.
2. Set `PUBLIC_BASE_URL` in `wrangler.jsonc` to your Worker URL.
3. `npm run db:migrate:remote`
4. Add the secrets listed in `.dev.vars.example` with `npx wrangler secret put <NAME>`, or run `scripts/set-secrets.sh`.
5. `npm run deploy`

You'll need a LINE Messaging API channel, a Meta developer app with the Threads use case, and an Anthropic API key.

### Known limits

Searching other people's posts and looking up other accounts requires Meta Business Verification and App Review, so v1 doesn't do either. You find posts yourself and paste the URL. The official API doesn't return like counts for other people's posts.

## How it was built

I wrote the requirements and the implementation contract (`SPEC.md`), made the architecture and trade-off calls, and checked the result against the tests. Most of the code was generated with Claude Code from that spec.

## 中文說明

在 LINE 貼一則 Threads 貼文網址（加上原文或截圖），Claude 依照你選的人設寫 5 則留言草稿。每則草稿附一個連結，點下去會先檢查安全規則，通過才打開 Threads 的回覆框，而且文字已經填好，要不要送出由你決定。機器人不會自動發文。後台會追蹤帳號成長和每則留言的成效。

- 架構：Cloudflare Workers＋D1＋Queue＋Claude API＋LINE Messaging API＋Threads 官方 API，設計上可以在 Workers 免費方案跑
- 測試：232 個單元測試、18 個端對端情境
- 開發方式：需求、規格（`SPEC.md`）和技術取捨由我決定，程式主要用 Claude Code 依規格產生，再用測試驗收

## License

MIT
