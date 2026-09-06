# Episode schema, version 1

An episode is the structured record of one pipeline run for one site. It is
the unit the learning loop reflects on. `episode.js` in the repo root is the
canonical definition; this page explains the shape and the rules. When the two
disagree, the code wins and this page is wrong.

## Events and episodes

Producers emit **events**: `{ v, episodeId, stage, ts, seq?, data, local? }`.
An episode id is 16 hex characters, generated per run. The stage is one of
`trigger, relay, fetch, cache, scan, links, analyze, critic, evaluate, escalate,
verdict, write, render, end`. `data` holds uploadable facts; `local` holds
local-only facts.

Consumers **assemble** events into an episode: `{ v, episodeId, startedAt,
endedAt, durationMs, mode, domain, stages, local?, timeline, eventCount }`.
Later events for the same stage merge over earlier ones, so a stage can be
recorded incrementally, and events may arrive out of order.

## Producers

- The extension in observer mode. The orchestrator records every stage from
  the return values of the agents it already calls; the content script reports
  `trigger` and `render` through the validated message boundary; the
  background worker posts each event to the local collector.
- The batch runner, headless. It captures events in-process and writes one
  assembled episode per site as ndjson.

Both use the same recorder, `createEpisodeRecorder`, which is inert when
observer mode is off and never throws.

## Rules

- **Allowlists, not blocklists.** Every stage has a fixed set of fields with
  types. An unknown field makes the event invalid and it is dropped with a
  console warning, never written.
- **Off means off.** With observer mode disabled the recorder creates no
  events and calls no sink. Tests assert a full relay produces zero events.
- **Zero user data in the uploadable form.** `stripLocal()` removes the local
  layer and fine timestamps, reduces document URLs to path only, re-filters
  every stage through its allowlist, and `validateEpisode(episode, { uploadable:
  true })` refuses any record that still carries a forbidden key anywhere.
  Tests smuggle a text field, a nested email, and a precise timestamp into an
  uploadable record and assert each is rejected.
- **Document URLs only, never the page URL.** The fetch stage carries the
  legal documents that were fetched. The page the user was on is user data
  and lives only in the local layer.

## Versioning

`EPISODE_SCHEMA_VERSION` is 1. Adding an optional field to a stage does not
change the version. Renaming or removing a field, or changing a type, does,
and consumers must then handle both versions until old records are gone.
