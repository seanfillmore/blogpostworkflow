# Final fix report
1. Name leak: buildSources context uses "A customer"; runSend replaces any phrased question containing the reviewer first name (whole word, case-insensitive) with templateQuestion (name-free). Tests: prompt has no name; fallback question.
2. Deterministic ids: fn-<week>-<sha1(messageId)[0:8]>-<answer position>; nextNoteNumber removed; README updated. Tests updated; re-file-after-partial-write test.
3. Ingest notify body adds withheld/blocked counts (withheldLines).
4. stripMobileSignature on last answer (iPhone/iPad/Android/Outlook). Tests.
Commands: node --test tests/agents/founder-notes*.test.js tests/lib/founder-notes*.test.js (78 pass); npm test: 6997 tests, 6978 pass, 0 fail, 0 cancelled.
Note: tests were written alongside the code, not strictly red-first.
