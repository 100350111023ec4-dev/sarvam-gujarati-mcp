# Sarvam Gujarati TTS MCP — Cloudflare Workers

Version 1.0 · Prepared 24 November 2026 · Single-owner deployment

## What this project does

A remote, OAuth-protected MCP server that converts Gujarati scripts (`gu-IN`) to individual WAV files using Sarvam Bulbul v4 Flash or v3. It returns temporary download links, actual WAV duration, voice ID, line index and role. Dialogue is generated sequentially to avoid mixing character lines. It does NOT generate animation, dub a video automatically, verify pronunciation by listening, or publish to social networks.

The Cloudflare OAuth Provider manages client registration (DCR and CIMD), authorization code/PKCE, token validation and refresh. Your owner-only password provides login and consent; the actual Sarvam API key remains a Worker secret. Private R2 stores audio, signed links expire (default 24 hours), and a Durable Object reserves quota atomically before API calls. No anonymous synthesis endpoint. This is a personal integration, not a multi-user identity platform or independently audited security product.

## 1. Prerequisites (Windows PowerShell)

- Node.js 22+ LTS: https://nodejs.org/
- Cloudflare account: https://dash.cloudflare.com/ (enable Workers, KV and R2; R2 may require billing setup even if you remain within free quotas)
- Sarvam account and API key: https://dashboard.sarvam.ai/
- ChatGPT account/workspace with Add custom MCP server and OAuth enabled. Availability is plan/workspace dependent; OpenAI's help article primarily documents Business and Enterprise/Edu. Do not assume Plus supports all custom apps. If your existing Buffer connector was created in the same interface, try that interface. If unavailable, use MCP Inspector independently.

Extract the ZIP, then open PowerShell in the extracted `sarvam-mcp-cloudflare` folder (the one containing package.json). Run:

```powershell
node --version
npm --version
npm install
npm test
npx wrangler login
npx wrangler whoami
```

If PowerShell blocks npm.ps1 or npx.ps1, use `npm.cmd` and `npx.cmd` instead, or run the commands in Command Prompt. Do not weaken execution policy globally. Keep generated package-lock.json for repeatable installs; use npm ci thereafter.

## 2. Create storage and choose the Worker URL

In the Cloudflare dashboard go to Workers & Pages, set/confirm your workers.dev account subdomain. Choose a Worker name, default `sarvam-gujarati-mcp`. Your exact endpoint will be `https://sarvam-gujarati-mcp.YOUR-SUBDOMAIN.workers.dev/mcp`. Do not copy the example domain literally.

Run:

```powershell
npx wrangler kv namespace create OAUTH_KV
npx wrangler r2 bucket create sarvam-gujarati-audio
npx wrangler r2 bucket lifecycle add sarvam-gujarati-audio expire-clips clips/ --expire-days 3 --force
npx wrangler r2 bucket lifecycle list sarvam-gujarati-audio
```

If Wrangler automatically updates config, check it before editing. If the bucket already exists, use your own dedicated bucket or change `bucket_name` to a unique name and use that name in the lifecycle command. Keep R2 public access **disabled**; the Worker serves temporary signed download links. Three-day lifecycle is a storage cleanup target, not an exact deletion deadline. Signed links expire sooner (24 hours default).

Open `wrangler.jsonc` (e.g. `notepad wrangler.jsonc`):

1. Replace `REPLACE_WITH_KV_ID` with the actual namespace ID from the command. Do not use the namespace name instead of ID. Keep binding `OAUTH_KV`.
2. Set `MCP_RESOURCE` to the exact canonical HTTPS Worker URL ending in `/mcp`, with no trailing slash. Match `name` and your real workers.dev subdomain. This value is public, not a secret. The server rejects other hosts and OAuth audience is bound to this URL.
3. Check R2 bucket name. The Durable Object is created automatically by the migration on deployment.
4. Optional: adjust `DAILY_CHAR_LIMIT` (default 6000 Unicode code points, UTC daily reset), `DAILY_REQUEST_LIMIT` (40 calls daily), and `AUDIO_LINK_HOURS` (24, max 48). The server reserves the whole dialogue batch before starting, including failed/unused calls; this is a conservative spending guard, not an exact billing calculation. Sarvam and Cloudflare have separate quotas/pricing. Never increase caps without checking budget.

## 3. Deploy and store secrets securely

```powershell
npm run check
npx wrangler deploy
npx wrangler secret put SARVAM_API_KEY
```

Paste your Sarvam key only when Wrangler prompts. Never put it into ChatGPT, wrangler.jsonc, source files, Git or a URL.

Generate TWO different 256-bit random values by running the following command twice. Save the first in a password manager as your owner login password. The second signs audio links and consent tickets; save it separately.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put OWNER_PASSWORD
npx wrangler secret put SIGNING_SECRET
npx wrangler secret list
```

At the prompt for each `secret put`, paste its corresponding value. The displayed list should contain the three secret names, not the values. `secret put` deploys a new Worker version. Initial deployment without secrets cannot synthesize speech or authorize a client; service readiness becomes true after all three secrets are configured. Confirm the printed Worker URL is identical to `MCP_RESOURCE` (excluding `/mcp`). If different, correct the config and redeploy.

Do not set secrets in `.dev.vars.example`; it is only an example. For local-only development, copy it to `.dev.vars` and fill values privately; canonical HTTPS and secure OAuth cookies mean the production deployment is the simplest end-to-end test. No actual secrets are included in the ZIP.

## 4. Verify the Worker before connecting

Set your base URL (replace the sample):

```powershell
$base = 'https://sarvam-gujarati-mcp.YOUR-SUBDOMAIN.workers.dev'
Invoke-RestMethod "$base/health"
curl.exe -i "$base/mcp"
Invoke-RestMethod "$base/.well-known/oauth-protected-resource/mcp"
Invoke-RestMethod "$base/.well-known/oauth-authorization-server"
```

Expected: health JSON `ready: true`; unauthenticated MCP is HTTP 401 (may also see an auth challenge); resource metadata names the exact MCP endpoint and authorization server; authorization server metadata contains `/authorize`, `/oauth/token`, `/oauth/register` and PKCE information. Do not disable authentication if discovery fails. If you have an existing public custom domain, use it consistently instead of workers.dev; the MCP handler's host allowlist may need adjustment for a custom domain, not required for this default deployment.

## 5. Connect to ChatGPT

In ChatGPT web, open Plugins / Apps, choose the plus button or Add custom MCP server (where available; workspace admin/developer-mode settings may apply). Enter:

| Field | Value |
|---|---|
| Name | Sarvam-AI-Chirag |
| Description | Gujarati speech and ordered dialogue WAV generation |
| MCP URL | YOUR exact deployed HTTPS URL ending `/mcp` |
| Transport | Streamable HTTP, if a choice is displayed |
| Authentication | OAuth |
| Client ID / secret | Use automatic registration (DCR or CIMD where offered); don't enter Sarvam API credentials here |

If ChatGPT requires static client credentials rather than automatic registration, use the OAuth provider's documented registration setup and ChatGPT's exact registered callback; do not invent credentials. On connecting, the Worker authorization page asks for your **OWNER_PASSWORD**, NOT the Sarvam API key. Verify the page is on your Worker domain, that the client/redirect are the intended ChatGPT connection, enter the password, and authorize. ChatGPT should discover three tools. If the connect screen is absent, check plan/workspace support rather than attempting to bypass it.

## 6. Test in ChatGPT

First ask `Use Sarvam-AI-Chirag to list available Gujarati voice settings. Do not generate audio.` It should call `sarvam_voice_options` without spending Sarvam credits.

Then ask `Use Sarvam-AI-Chirag to generate one Gujarati WAV in bulbul:v3 using ratan, pace 0.9: ભાઈ, રજા માટે નાનો ઈમેલ લખી આપને! Return the download link and duration.` This is a billable voice-generation test. Open the returned signed link in your browser, listen and save the WAV. Links may not render as an inline player in ChatGPT. They are private capability URLs: anyone who obtains a link can listen until expiry; don't share them publicly.

If your ChatGPT account cannot connect, test independently via MCP Inspector:

```powershell
npx -y @modelcontextprotocol/inspector
```

Open the Inspector URL printed in the terminal. Select Streamable HTTP, enter the exact MCP URL, connect via OAuth if supported by your Inspector version, and list tools. This validates the service separately from ChatGPT.

## 7. Dialogue tool and today's reel

Tools:
- `sarvam_voice_options`: no paid synthesis; example voices, not a live catalog.
- `sarvam_generate_speech`: one Gujarati line, 1–600 characters, model and speaker optional, pace 0.7–1.2.
- `sarvam_generate_dialogue`: 1–8 lines, maximum 2400 characters total, role per line. Generates separate WAVs sequentially and returns the actual duration and ordered links. On failure, stops and includes successful clips; don't repeat those calls. Default v4 speaker is `pooja_gu_conversational` (dedicated Gujarati female). V3 `ratan` is a documented Gujarati male pick. The included sample uses these two different voices for the employee and robot; audition before publishing. For a second male voice, choose a documented alternative (e.g. `dev_en_conversational` with v4 and `gu-IN` is cross-language, not guaranteed native-sounding). Verify in the Sarvam voice catalogue first. v3 and v4 use different ID formats; exact available IDs are validated by Sarvam.

The project includes `sample-dialogue.json` for the four-line leave-email joke. You can open it and paste the dialogue (no credentials) into ChatGPT, requesting the batch tool and exact text, in order, with no overlapping lines. Keep links and durations, download files immediately, add pauses between lines, then combine with separately generated animation in your editor. Sarvam's generation is not guaranteed word-perfect; listen to all four audio tracks before creating the final reel. No text or branding on the final video; put name and social links in the caption. Do not publish before approval.

## 8. Troubleshooting and security operations

| Symptom | Check |
|---|---|
| Build cannot find `agents/mcp/server` or SDK v2 | Install current `agents` and `@modelcontextprotocol/server` compatible with Cloudflare's v2 guide; retain lockfile after successful install. Run `npm run check`. |
| 503 health | Three secrets set, correct `MCP_RESOURCE`, actual deployed host. |
| 401 MCP without token | Expected. Use OAuth, not API key authentication. |
| OAuth page error | Exact URL, valid client registration, correct owner password; restart from ChatGPT after a failed or expired consent. |
| 429 consent | Maximum 15 owner authentication attempts per UTC hour globally. |
| Sarvam 400/422 | Model and speaker ID must match, choose verified catalogue IDs and Gujarati text. |
| Sarvam 401/403 | Invalid API key or access; replace Worker secret. |
| Sarvam 429 | Service rate limit or balance; inspect Sarvam account. No auto-retries. |
| 403 audio | Link expired or modified; download within 24h. No public bucket needed. |
| Daily cap | UTC midnight resets the app quota. Change caps only intentionally. |
| Tool appears unavailable | Refresh tool list / reconnect after deploy, if account supports custom apps. |

Security: use unique high-entropy secrets; never authorize unknown clients; owner consent page uses a signed expiring request and same-origin cookie to resist CSRF, with rate-limited password attempts. No raw audio/text is logged by this implementation; Cloudflare and Sarvam may have platform-level request/retention practices. Do not submit confidential work data or private personal information. For lost credentials, rotate `SARVAM_API_KEY`, `OWNER_PASSWORD` and `SIGNING_SECRET` as appropriate. Rotating the password alone does NOT revoke already-issued OAuth grants. For a suspected OAuth compromise, disconnect ChatGPT, provision a fresh dedicated OAUTH_KV namespace and update the binding/redeploy to invalidate all old tokens; rotate Sarvam key and signing secret, and reconnect. The old dedicated namespace can then be deleted after you verify that no other deployment uses it. Rotating SIGNING_SECRET invalidates previously issued download links. To shut down, disable/delete Worker and remove bindings/bucket objects/namespace as desired after saving needed audio. Keep public R2 access off.

## 9. Verification status

The package contains complete source, configuration template, secret setup, OAuth route, quota logic, private audio download handler, example dialogue and Node unit tests. Syntax checks and unit tests were run locally; npm dependency installation/bundling, OAuth end-to-end handshake, live Sarvam speech, and deployment were not verified in the authoring environment (no live accounts/registry access). Run `npm install`, `npm test`, `npm run check`, then the deployment and smoke tests above. A real API key and Cloudflare account are required. No video or audio generation has been charged by preparing this package.

## Reference documentation

- Sarvam TTS: https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/best-practices
- Sarvam REST: https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/rest-api
- Sarvam voice selection: https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/how-to/change-the-speaker-voice
- Cloudflare remote MCP: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- Cloudflare MCP handler: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- Cloudflare OAuth: https://github.com/cloudflare/workers-oauth-provider
- Cloudflare Worker secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- ChatGPT custom MCP: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- OpenAI plugin authentication: https://developers.openai.com/plugins/build/auth
