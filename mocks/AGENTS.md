# mocks

Replays recorded agent sessions through native stdout, JSON-RPC ACP, or AMR protocols.
**Use this for every stream/parser change** — it is deterministic and burns no provider
budget.

```bash
export PATH="$PWD/mocks/bin:$PATH"
export READABLE_MOCKS_TRACE=<8-char-id>
export READABLE_MOCKS_NO_DELAY=1
```

18 PATH-overlay wrappers in `bin/` cover the native CLIs (`opencode`, `claude`, `codex`,
`gemini`, `cursor-agent`, `deepseek`, `qwen`, `grok`), the ACP family (`devin`, `hermes`,
`kilo`, `kimi`, `kiro`, `vibe`) and the AMR `vela` CLI.

The trace catalog, recording instructions and remaining selection knobs
(`READABLE_MOCKS_BY_PROMPT_HASH`, `READABLE_MOCKS_POOL`, `READABLE_MOCKS_SEED`) are in
`README.md` — read it rather than reverse-engineering `mock-agent.mjs`.

`golden/` holds assertions, not samples. If a golden file changes, say why in the PR
body.
