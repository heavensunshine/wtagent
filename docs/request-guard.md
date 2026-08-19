# Request guard and provider circuit breaker

WTAgent can generate several web-model requests during one local task: the opening prompt, tool-result turns, protocol corrections, empty-response continuation messages, and rare transport retries. The request guard puts a local safety boundary around every physical provider-adapter send so an accidental loop cannot issue requests indefinitely.

These limits are WTAgent defaults only. They are not published provider limits and must not be interpreted as a threshold that guarantees account safety.

## Defaults

```json
{
  "requestGuard": {
    "minIntervalMs": 15000,
    "maxRequestsPerRun": 20,
    "maxRequestsPerHour": 30,
    "circuitOpenMs": 3600000
  }
}
```

The values can be overridden in `config.json`. With the default profile, this is the same `$WTAGENT_HOME/config.json` used for web-provider selection (or the platform-specific WTAgent data directory when `WTAGENT_HOME` is not set). When `--profile-dir` points to a custom location, the guard reads `config.json` from that profile directory's parent so its configuration stays tied to the selected browser profile.

- `minIntervalMs` spaces physical model-request attempts. WTAgent waits locally before sending; local filesystem, Git, terminal, and other tools are not counted.
- `maxRequestsPerRun` is a hard budget for one `AgentRuntime.run()` lifecycle. Interactive follow-up turns and explicit resumes start a fresh per-run budget.
- `maxRequestsPerHour` is a rolling-hour hard budget persisted in the dedicated Chrome profile, so restarting WTAgent or launching another WTAgent process does not reset the hourly accounting.
- `circuitOpenMs` controls how long a provider circuit remains open after a confirmed usage-limit response. After the cooldown, a later user-initiated run may make a normal probe; if the provider still reports a limit, the circuit opens again.

Every call to the provider adapter's `sendMessage()` reserves one request before attempting the send. This deliberately includes reconnect retries and `SEND_NOT_DETECTED` retries: a failed or uncertain send still consumes local budget rather than being treated as free.

## Circuit breaker

When the provider adapter reports `USAGE_LIMIT_REACHED`, or the existing ChatGPT text fallback recognizes a usage-limit notice, WTAgent records a provider-specific open circuit. Further sends fail locally with `PROVIDER_CIRCUIT_OPEN` until the configured cooldown expires.

The circuit breaker does **not** switch ChatGPT thinking modes, switch providers, retry around the provider limit, or replay local tools. The run stops and leaves control with the user.

## Persistent state and failure mode

Guard state is stored as `.wtagent-request-guard.json` inside the dedicated Chrome profile. A small lock directory serializes reservations from concurrent WTAgent processes so they cannot both consume the same last hourly slot. State writes are atomic and owner-only where the platform supports POSIX permissions.

Malformed guard configuration, corrupt accounting state, an unsafe state path, or failure to acquire the guard lock all fail closed: WTAgent sends no additional model request until the local problem is corrected.

Deleting the dedicated Chrome profile (for example with `wtagent logout`) also deletes its guard history because the accounting state is intentionally tied to that browser profile/account context.
