# Bug report: can't book back-to-back meetings

**Reported by:** several users

> Our Standup in the Hangar room runs 09:00–10:00. When I try to book the
> Hangar from 10:00 to 11:00, the app says the room is already booked by
> "Standup". The standup is over at 10:00, so the room should be free.

Expected: a meeting that starts exactly when another one ends in the same
room can be booked.

Actual: the booking is rejected as a conflict.

QA added a test that reproduces this report in `test/bookings.test.js`; it
currently fails. Run the tests with `npm test` (no install needed — only
Node.js).
