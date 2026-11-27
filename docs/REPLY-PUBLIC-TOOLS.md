# Reply-only public tools

Scope: `ReplySuggest → summaryrec` and `ai-reply/generator` share the bounded runtime in
`query/reply-tools`. **Ask/微信问答 is not changed.** No sending, shell, file-write,
account or Webhook tool exists. Existing IPC trust, License and HTTP method permissions
remain outside this runtime. Calls with several tool IDs are executed serially and each
result is correlated with its issued ID; the existing OpenAI-compatible bridge is reused.

Tools: `weather`, `search_web`, `current_datetime`, `calculate`, `convert_units`,
`read_public_url`. The model chooses calls; there is no pre-injected weather answer.
Weather has a fail-closed evidence guard: without a successful weather tool result,
weather questions cannot surface an invented forecast. URL summaries use bounded page
text in the same generation model, not a second unrestricted summarizer.

## Server-only configuration (no credentials in renderer)

No live configuration is changed by this implementation. Providers default **disabled**.
Do not reuse the model key. Public config lives in the existing data-root `config.json`;
keys live only in the existing permission-protected `secrets.json` or the process env.

| Public config | Value | Env fallback |
| --- | --- | --- |
| reply_weather_provider | open-meteo | SUPERTIME_REPLY_WEATHER_PROVIDER |
| reply_weather_access | noncommercial or commercial | SUPERTIME_REPLY_WEATHER_ACCESS |
| reply_search_provider | brave | SUPERTIME_REPLY_SEARCH_PROVIDER |

| Secret field | Env fallback |
| --- | --- |
| reply_weather_api_key | SUPERTIME_REPLY_WEATHER_API_KEY |
| reply_search_api_key | SUPERTIME_REPLY_SEARCH_API_KEY |

`noncommercial` is an explicit operator assertion that the deployment qualifies for
Open-Meteo's public noncommercial API, **not a claim that a commercial product is free**.
Commercial access requires an operator-supplied licensed key and uses the documented
customer-prefixed Open-Meteo hosts. Confirm the supplier's current licence/plan before
commercial deployment. This change does not buy/register any service or persist keys.
Brave uses its documented JSON web-search API with `X-Subscription-Token`; no search-page
scraping or model-key substitution occurs. Missing/invalid provider/key/licence mode
returns a structured unavailable result to the model and UI.

Weather geocodes internally, stops on ambiguous/no results, reports forecast day and local
timezone (China uses Asia/Shanghai), °C/mm/percent, fetchedAt and provider attribution.
`providerIssuedAt` remains unknown unless supplied; fetch time is never called issuance
time. Forecast probability is not a guarantee of rain. No weather data is hardcoded.
Search sends a bounded subset of the current target question, rejects obvious identifiers
and credentials, and cannot expand from hidden KB/chat. This is conservative minimization,
not a general DLP classifier; do not ask it to search private customer/person information.
URLs must occur literally in the target message, only HTTPS/443, no credentials. All hops
resolve public addresses, reject a mixed/private DNS answer and pin the chosen validated IP
for the TLS connection. Redirects cannot forward provider credentials across origins.
Bodies are limited to 64 KiB, text/HTML/JSON; script/style content is removed before the
model receives a bounded, explicitly untrusted text result. No cookies or local sessions.

## Bounds and cancellation

4 model turns / 6 calls total / 3 calls per turn, 60 seconds total, 10 seconds per tool,
6.5 seconds per HTTPS operation, 3 redirect hops, strict argument schema and output limits.
Existing automatic-reply 6000-token target / 1.35 hard-overrun ceiling is not increased;
the same conservative estimator also counts schemas, results, messages, system text and
image reserves. Manual suggestions trim oldest context first to reserve tool space;
automatic replies retain their upstream context assembly and degrade without tools if
schemas/results cannot fit. Oversized requests fail rather than relaxing the ceiling.
Provider unsupported-tools responses get a clearly marked no-tools fallback. Cancellation
aborts model/HTTP, prohibits later tools/rounds, and preserves the runner's no-send-on-cancel
policy. Tool observations contain name/status/code/duration only, never raw arguments.

Reply cache prompt version is bumped; realtime-capable results expire after five minutes.
Tool provider/key-presence changes also invalidate the manual candidate key. Frontend only
shows safe stage metadata and public source metadata, not credentials/tool arguments.

## Validation boundary

Synthetic tests cover both generation entrances, tool IDs, weather contracts, unavailable
configuration, errors, schema/SSRF/cancellation/budget limits. They are not live weather
results. A real application acceptance requires a configured licensed provider or explicit
noncommercial test setting, then one candidate generation on the existing weather message.
Never enable automatic replies, send to WeChat/Webhook, or fabricate provider success for
this test. No commit/push/installer/release step is part of this change.
