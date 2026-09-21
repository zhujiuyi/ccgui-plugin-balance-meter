# How it works

The plugin follows the channel your current session actually uses and shows its balance or subscription quota; when a channel can't be queried it says so instead of guessing a number.

## What it can show

- DeepSeek, Moonshot / Kimi, SiliconFlow: account balance.
- OpenRouter: total and used credits.
- OpenCode Go subscription: rolling, weekly, and monthly quota windows.
- OpenAI ChatGPT subscription: when Codex signs in with a ChatGPT account, the 5-hour and weekly windows.
- Claude subscription: when Claude Code signs in with a subscription account, the 5-hour and 7-day windows. This channel relies on an undocumented official endpoint and may stop working after an update.
- Kimi For Coding: works with an API key, or reads the local Kimi Code CLI login automatically. Shows the 5-hour and weekly windows.
- Zhipu GLM / Z.AI coding plan: the 5-hour and weekly windows, using the plan's own API key.
- MiniMax coding plan: the 5-hour and weekly windows.
- Grok subscription: when the Grok CLI is signed in locally, the current billing period's usage.

## When it can't find a number

- Unrecognized relays (New-API, One-API and similar): the plugin tries a few common query styles; whether it works depends on the relay, and it is not guaranteed support.
- If your provider has a query endpoint, set a custom endpoint in the plugin settings — it takes effect immediately and supports the {base} and {origin} placeholders.
- A quota window that has not been used yet may show no reset time; that is expected.

## When it refreshes

- Once when CC GUI starts.
- When you switch tabs, sessions, or engines, it follows to the matching channel and queries again.
- Once after each completed turn, at most one automatic refresh every 30 seconds.
- Manual refresh is always available from the status panel, the plugin settings, or the command palette.

## Data and permissions

- The plugin only reads your local AI tools' configuration and login state, to determine which channel is in use.
- That information is used solely for read-only queries to your own provider: nothing is logged, nothing is sent to a third party.
- When a login expires the plugin will not refresh it for you; it only asks you to sign in again.
- Reading local files and making requests both go through the system's built-in command-line tools; CC GUI's internal data is not read.

## Platforms

- Windows: verified.
- macOS and Linux: adapted, not yet tested on real machines.
- Detecting the current session immediately at startup needs a recent CC GUI version; older versions may need a tab switch or one message first.
