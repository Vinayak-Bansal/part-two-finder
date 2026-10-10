# Accuracy tests

`cases.tsv`: category, creator, reel sent, correct part 2 (`none` = there is no part 2 yet).

Run against the deployed bot (no DMs are sent):

    /api/test?key=TEST_KEY&cases=SENT>EXPECTED|SENT>none|...      (3 cases per call is safe)
    add &blind=1 to hide "part N" from every caption (forces the AI cover/video path)
    /api/test?key=TEST_KEY&dm=SHORTCODE                           exact DM reply text

Meta allows roughly 200 creator lookups per hour for this app, so run ~20 cases at a time.

Story-matching check for creators who reuse one caption/cover: hide the real part 2 with
`&exclude=CODE` and expect `none` (the bot must not grab the next unrelated video).
