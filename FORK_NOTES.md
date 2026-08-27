# Fork notes

Prepared changes for a personal fork of `luojiyin1987/wtagent`.

## Proposed additions

- `docs/opencode-integration.md`
  - explains the OpenCode -> WTAgent -> ChatGPT Web flow
  - distinguishes custom tools from provider configuration
  - documents global/project tool locations
  - records the prompt-level read-only safety boundary

- `examples/opencode/wtagent.ts`
  - cleaned copy of the upstream OpenCode demo
  - adds `Pro` to the accepted WTAgent mode list
  - keeps `High` as the default mode

## Upstream preservation

The upstream `opencode-call-wtagent-demo.ts` should be left untouched unless you intentionally want to replace it.
Keeping additions under `docs/` and `examples/` makes rebasing from upstream easier.
