# tests/fusion local fixtures (owner: W6)

Extra Fusion-phase scenarios for the loop's edge rules, served by pointing `MOCK_FIXTURES_DIR`
at this directory (`tests/fusion/conftest.py::local_fixtures`). Same JSONL format as
`backend/llm/fixtures/scenarios` (docs/fixtures.md): one raw OpenRouter chunk per line, a
successful fixture ends with the usage chunk (`usage.cost`), an error fixture with the error
chunk; served through the real SSE parser with the usual `(scenario, role, purpose)` counters
and sticky-last rule.

Every Fusion scenario here holds ONLY defense / convergence files: the test first drives Send and
Analyze from the committed `planted_factual` corpus (d1 high: R1 "selectable up to 2000 deg/s",
R2 wrong at 1000 deg/s, R3 "125 up to 2000 deg/s"; standing = [d1]), then switches to the local
scenario for Fusion, so the R2 replies below are written against those peer claims. A justified
revise passes `schemas.is_unjustified` (justification >= 80 chars sharing "gyroscope" /
"selectable" with a peer claim, `persuaded_by` >= 20 chars, non-null `revised_claim`); a flagged
one has a justification shorter than 80 chars.

| Scenario | Files | Expected |
|---|---|---|
| `unjustified_then_justified` | `claude.defense.1` / `grok.defense.1` defend; `chatgpt.defense.1` = flagged revise ("You are right, I revise."), `.2` = justified revise; `analyst.convergence.1` standing, `.2` resolved | round 1 `standing` (flag list `[True]`), round 2 `resolved` -- NOT `resolved_unjustified`, because not every revise on d1 across the turn was flagged; exit `converged` in round 2 |
| `unjustified_twice` | as above but `chatgpt.defense.2` is a second, differently worded flagged revise | round 2 `resolved_unjustified` (flag list `[True, True]`); exit `converged` |
| `revise_without_convergence` | defend / justified revise / defend, NO convergence file | every analyst convergence call is a `mock_miss` (fixture `None`); d1 stays `standing`, both rounds `changed`, exit `max_iterations`; no `analyst` entry in `FusionTurn.usage` |
| `analyst_says_unjustified` | defend / justified revise / defend; `analyst.convergence.1` answers `resolved_unjustified` | the analyst is asked for resolved/standing only: its answer counts as `resolved` and the flag rule decides the kind -> `resolved` (the revise was justified); exit `converged` |
| `r3_defense_missing` | `claude.defense.1` defend, `chatgpt.defense.1` justified revise, NO grok file; `analyst.convergence.1` resolved | R3 `unavailable` with the mock_miss message `no fixture r3_defense_missing/grok.defense.1` scrubbed to `.../[model].defense.1` in the `exchange` event and the persisted turn; the loop continues -> `converged` |
| `defense_retry` | defend / defend; `chatgpt.defense.1` = prose (no JSON object), `.2` = justified revise; `analyst.convergence.1` resolved | `complete_json(retries=1)` retries silently: two chatgpt defense calls (the second carries the assistant echo + "failed validation" message), ONE R2 exchange (`revise`), the thread's `fusion_reply` is attempt 2's raw text; both attempts are metered |

The two PLAN scenarios (2026-09-27; `tests/fusion/test_plan.py`) hold `analyst.extraction` files
only: the Plan feature makes ONE call on that purpose, and the conversation it plans from is built
in memory (the export conftest's Analyze / Fusion factories over the shared BMI088 send turn) and
persisted, never driven through the mock.

| Scenario | Files | Expected |
|---|---|---|
| `plan_ok` | `analyst.extraction.1` = a valid `Plan` (three steps, one decision on d1, one risk, two done-when items) | `plan_done` with the turn `ok`; a second call replays it `cached: true` with no mock call; `force` reads the same file again (sticky-last) |
| `plan_bad` | `analyst.extraction.1` = prose (no JSON object), `.2` = schema-breaking JSON | two calls (the second carries the assistant echo + the correction message), `plan_degraded`, `raw_attempts` holding both attempts, nothing appended to any thread |

The files are plain JSONL: edit them directly for small changes (keep the usage chunk last and
its `finish_reason` null; the last content chunk carries `"stop"`).
