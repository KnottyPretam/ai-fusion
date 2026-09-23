Pre-parse's one analyst call answered with a FENCED `{"question": ...}` block (the shape a web
analyst is asked for; `extract_json` reads a fence on every transport) plus a usage chunk: the
default prompt restated with one word moved, so a test can tell the restatement from the
original. Sticky-last serves it again for a second Pre-parse in the same test.
