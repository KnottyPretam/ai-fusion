Pre-parse's analyst call answers valid JSON whose `question` is whitespace only. Valid for the
schema, useless as a prompt: the run degrades with the empty-restatement message instead of
handing back a blank question, and nothing is retried (the JSON itself was fine).
