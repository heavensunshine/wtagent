# Web providers

WTAgent separates the local agent runtime from the web AI site that carries the model conversation.

## Selecting a provider

The provider is resolved in this order:

1. `--provider <name>`
2. `WTAGENT_PROVIDER`
3. `provider` in `$WTAGENT_HOME/config.json`
4. `chatgpt`

Example config:

```json
{
  "provider": "chatgpt"
}
```

Example CLI override:

```bash
wtagent --provider chatgpt --once --json -C ./project "review this change"
```

The provider selected for a new session is persisted in that session. `wtagent resume` keeps using the persisted provider even if the global config changes later; an explicit attempt to resume with a different provider is rejected.

## Registered providers

Currently only `chatgpt` is registered. The provider registry is intentionally separate from provider configuration so additional web adapters can be added without changing the agent runtime, XML protocol, tool policy, replay protection, or OpenCode integration.

A future provider adapter is responsible for its own browser behavior such as authentication detection, conversation lifecycle, send/completion detection, message identity, cancellation, attachments, and mode capabilities. Provider configuration does not expose arbitrary DOM selectors.
