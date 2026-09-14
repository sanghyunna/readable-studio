## Databricks fixtures

Limit discovery audit (2026-09-11): the recorded UC model-service GET below has
only identity, timestamps, routing and supported API types; its live target
contains `model` and `native_api_types`, not token limits. The recorded serving
inventory similarly has name/type/task/state/permission, not context or output
maxima. Neither body contains any context, token or limit field. This proves
absence for these captures, not all workspaces or future API revisions.
`capabilities.test.ts` checks those recorded machine fields; synthetic metadata
cases separately exercise explicit limits overriding the identity table.
Provider specification URLs and the date checked live are kept with every row
in `src/databricks/capabilities.ts`. Luna GET metadata in integration tests is
synthetic (derived from its captured response identity), not a new live capture.

`luna-chat-completions.json` came from `04-live-probe.md` and captures the OpenAI Chat Completions request/response pair for `app_dev.default.oai-luna-model-service`; assert that request `model` is the fully-qualified service name and response `model` is `gpt-5.6-luna`, with 200 JSON success fields present.

`claude-messages.json` came from `09-claude-sonnet-probe.md` and captures the Anthropic Messages request/response pair for `app_dev.default.c-sonnet-model-service`; assert request `model` is the fully-qualified service name, response `model` is `claude-sonnet-5`, and content is `OK`.

`claude-messages-stream.txt` came from `09-claude-sonnet-probe.md` and records the Anthropic Messages stream event sequence; assert that the parsed sequence preserves `start`, `text_start`, `text_delta`, `text_delta`, `text_end`, `done` and that stream text resolves to `OK`.

`claude-errors.json` came from `09-claude-sonnet-probe.md` and stores the two verified HTTP 400 rejection bodies; assert both legacy `thinking.type.enabled` and `output_config.effort: minimal` are rejected with matching status and error shape.

`uc-model-services-list.json` came from `06-token-paths.md` plus `09-claude-sonnet-probe.md` and encodes the model-service list from `schemas/app_dev.default`; assert it contains exactly the two services `app_dev.default.oai-luna-model-service` and `app_dev.default.c-sonnet-model-service`.

`uc-model-service-get.json` came from `09-claude-sonnet-probe.md` and captures the direct GET for `app_dev.default.c-sonnet-model-service`; assert `supported_api_types` includes Anthropic chat messaging and that routing target is `claude-sonnet-5`.

`serving-endpoints-list.json` came from `04-live-probe.md` and `09-claude-sonnet-probe.md` and captures the serving-endpoint inventory; assert it contains exactly the eleven `databricks-*` foundation endpoints and excludes both model-service names.
