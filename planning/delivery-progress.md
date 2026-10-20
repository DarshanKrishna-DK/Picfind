# Delivery evidence

Target: at least 70 substantive PRs, reviewed and merged. Each diff must contain
fewer than 5,000 added plus deleted lines. The owner authorized approval labels
and merges on 2026-10-20. Passing checks and a review remain required.

The [Shipwright leaderboard](https://shipwright-agent.onrender.com/leaderboard)
ranks merged PRs with a follow-up push after review. At the last verified refresh
on 2026-10-20, Picfind had 8 pushed after review, 14 merged and
reviewed, and 14 opened. This is a
timestamped observation, not a live counter or a promise of event credit.

| PR                                                         | Outcome                                  | Merge and review evidence                                                                   |
| ---------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| [2](https://github.com/DarshanKrishna-DK/Picfind/pull/2)   | Competitor evidence and product roadmap  | Merged; later Shipwright review and evidence replies                                        |
| [3](https://github.com/DarshanKrishna-DK/Picfind/pull/3)   | Selection filename exports               | Merged; later Shipwright review                                                             |
| [4](https://github.com/DarshanKrishna-DK/Picfind/pull/4)   | Pinned local CPU face-runtime evaluation | Merged; later review, listener follow-up in #7                                              |
| [5](https://github.com/DarshanKrishna-DK/Picfind/pull/5)   | Cross-platform validation repair         | Merged; later review, listener follow-up in #7                                              |
| [6](https://github.com/DarshanKrishna-DK/Picfind/pull/6)   | Matching preparation readiness           | Reviewed, assertion improved after review, re-reviewed, merged                              |
| [7](https://github.com/DarshanKrishna-DK/Picfind/pull/7)   | Fail-closed validation listeners         | Reviewed and merged                                                                         |
| [8](https://github.com/DarshanKrishna-DK/Picfind/pull/8)   | Enforced PR size budget                  | Reviewed, false findings answered with CI evidence, approved and merged                     |
| [9](https://github.com/DarshanKrishna-DK/Picfind/pull/9)   | Compare client selection requests        | Reviewed, export cancellation improved after review, re-reviewed, merged                    |
| [10](https://github.com/DarshanKrishna-DK/Picfind/pull/10) | Offline face-score calibration reports   | Reviewed, exhaustive threshold and provenance tests added after review, re-reviewed, merged |
| [11](https://github.com/DarshanKrishna-DK/Picfind/pull/11) | Photographer-defined selection counts    | Reviewed, gallery availability fixed after review, re-reviewed, merged                      |
| [12](https://github.com/DarshanKrishna-DK/Picfind/pull/12) | Submission deadlines and reopening       | Reviewed, unchanged-snapshot timer fixed after review, re-reviewed, merged                  |
| [13](https://github.com/DarshanKrishna-DK/Picfind/pull/13) | Guest request receipts                   | Reviewed, session-isolation tests strengthened after review, re-reviewed, merged            |
| [14](https://github.com/DarshanKrishna-DK/Picfind/pull/14) | Private photo instructions               | Reviewed, draft lifecycle and moderator privacy corrected after review, re-reviewed, merged |
| [15](https://github.com/DarshanKrishna-DK/Picfind/pull/15) | Named proofing collections               | Reviewed, candidate pagination and draft protection fixed after review, re-reviewed, merged |

GitHub currently proves fourteen merges in this delivery batch. PRs #6, #9, #10, #11, #12, #13, #14 and #15 were visibly
credited in the follow-up-push column at the observation above. New work must
preserve that distinction. No production deployment is implied by these merges.

## Client selection comparison

Roadmap item 19 compares two persisted submissions through the existing owner-only
insights projection. The interface shows union, shared, and one-request-only
favorites, retaining photo identity when filenames collide. Each request is a
submission, not a verified person. Deleted or expired photos are omitted.
CSV export reauthorizes and refreshes availability; it includes only photo IDs
and filenames. It does not change a selection, send messages, or expose private
review notes. Existing persistence and authorization remain the source of truth.
