# plan_bad

Two attempts that both fail the parse / validation step, so the Plan feature degrades after its
one correction attempt (`refactor.validated_call`, `ATTEMPTS = 2`):

- `analyst.extraction.1.jsonl` -- prose, no JSON object at all (`parse_error`), so the correction
  message carries it back as the assistant turn;
- `analyst.extraction.2.jsonl` -- a JSON object that breaks the schema (`objective` is a number,
  `steps` a string), so the second attempt fails validation and the turn is `degraded` with both
  attempts recorded.
