Condense calls that answer with claims about as long as the replies they were given: the
condensed total stays over `CONDENSED_MAX_CHARS` (20,000) after the first pass, the second pass
re-serves the last file (sticky-last) for every piece and stays over too, so the comparison call
is never made and the turn degrades naming the largest block (`condense_ineffective`). There is
deliberately no comparison file: a comparison call here would be a bug.
