# Favorites submission deadlines

Owners can schedule a future deadline, close submissions immediately using server
time, or reopen without a deadline. The window controls new favorites submissions.
Gallery visibility, gallery expiry, passcodes and saved requests are unchanged.

`PATCH /events/:id/selection-window` accepts one strict command:
`{ action: "open" }`, `{ action: "close" }`, or
`{ action: "schedule", closesAt: "<UTC ISO timestamp>" }`.
Only the event owner can change it. The existing event billing transaction persists
`selectionClosesAt` in the Appwrite JSON payload; no table or index migration is
needed. Missing metadata and an empty string mean open. Invalid stored metadata
fails closed for submissions while owner repair and gallery viewing stay available.

Deadlines must be in the future and no later than a configured gallery expiry.
Submissions at or after the cutoff receive `SELECTIONS_CLOSED`. The server checks
the window after entering the account lock and again immediately before saving,
after asynchronous photo and submission reads. The final policy read also rechecks
gallery availability and passcode access. These checks use the existing account
lock and event settings contract, not a new distributed transaction guarantee.
Existing submissions are never rewritten or removed by a deadline change.

The public access projection and owner insights return the deadline, closed/invalid
state and server time. The guest interface uses elapsed monotonic time from that
snapshot to close an already-open form, independent of the device wall clock.
Network delay can make that indication late; the server remains authoritative.
A refetch of the same snapshot preserves elapsed time. Unusable clock snapshots
close the form without starting a timer. Stored deadlines use canonical UTC ISO
timestamps with millisecond precision, as written by every schedule/close action.
A closed response refreshes the policy, and guests can refresh after reopening.
Selected photo IDs survive a close/reopen within the mounted gallery view.

The owner uses a local date/time input with an explicit device time-zone label;
the request persists an absolute UTC timestamp. Round-trip validation rejects
local times normalized into a different time by a daylight-saving transition.
Displayed deadlines include the device time zone. Repeated local times during
clock rollback use the browser Date interpretation; the saved absolute timestamp
is displayed after saving for confirmation.

Synthetic tests cover authorization, exact cutoff, delayed storage reads, expiry
bounds, corrupt metadata repair, billing persistence, reload, owner controls,
device clock skew and guest reopening. No notifications are sent by this feature.
