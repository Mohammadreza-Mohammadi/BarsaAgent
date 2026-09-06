# BarsaAgent v1.2 — Implementation Notes

## Source baseline

Built from BarsaAgent v1.1.3 and integrated with `docs/reference/create-task-flow.md`.

## Major changes

- No protocol patch files; Manager remains external.
- New `/api/tasks/create` accepts confirmed task drafts.
- Import payload: `repo/type/slug/requestText/source?`.
- Manual task creation supported by omitting `source`.
- Sequential imports; one failure does not stop later items.
- Global run queue with configurable `maxConcurrent`.
- `autoStartOnCreate` and `autoResumeAfterAnswer`.
- Clarification answer uses temp UTF-8 file and `--clarify --file`.
- Merge rejection supports `--route implementer|architect`.
- Health endpoint invokes `npm run validate-agent-work --silent` and returns persistent status to UI.
- Issue adapter supports POST JSON/form, current UserId, and double-serialized JSON response.
- Issue mapping updated to `externalId/title/body/url/status/labels` with fallback mapping.
- UI has issue stepper/create draft, manual task, queued badge, merge evidence, health status.

## Test status

`node --test server/test/*.test.js`: 16 passed, 0 failed.

Coverage includes:
- CLI-only board/task/events
- artifact traversal rejection
- duplicate run rejection
- SSE replay/token masking
- POST issue JSON/form
- double-serialized issue response
- create + auto-start
- clarification file + auto-resume
- import failure isolation
- maxConcurrent queue
- Manager Contract handshake

## Build note

The execution container has Node 22.16.0 while Angular 22 package metadata in this project requires Node `^22.22.3 || ^24.15.0 || >=26`. Server tests are valid; perform the final Angular build on a supported Node version.
