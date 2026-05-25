# Greenhaven Broker Prompt

This file is intentionally not the broker prompt source anymore.

The broker prompt is assembled from domain fragments in `prompts/broker/` by
`src/ai/prompts.ts`. Keep gameplay rules in the smallest matching fragment and
update the manifest/smoke checks instead of turning this file back into a
catch-all prompt.