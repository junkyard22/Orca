// Meeting-room booking rules.
//
// Times are "HH:MM" strings on a single day. A booking occupies the
// half-open interval [start, end): a meeting that ends at 10:00 has left
// the room by 10:00.

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(value) {
  const match = TIME_PATTERN.exec(String(value ?? "").trim());
  if (!match) {
    throw new Error(`Invalid time "${value}". Use 24-hour HH:MM.`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function toInterval(booking) {
  const start = parseTime(booking.start);
  const end = parseTime(booking.end);
  if (end <= start) {
    throw new Error(`Booking "${booking.title ?? "untitled"}" must end after it starts.`);
  }
  return { start, end };
}

export function overlaps(a, b) {
  const first = toInterval(a);
  const second = toInterval(b);
  return first.start < second.end && second.start < first.end;
}

export function findConflicts(schedule, request) {
  return schedule.filter(
    (existing) => existing.room === request.room && overlaps(existing, request),
  );
}

export function bookRoom(schedule, request) {
  if (!request.room) {
    throw new Error("A room is required.");
  }
  const conflicts = findConflicts(schedule, request);
  if (conflicts.length > 0) {
    const names = conflicts.map((c) => `"${c.title}" (${c.start}-${c.end})`).join(", ");
    return { ok: false, reason: `Room ${request.room} is already booked: ${names}.` };
  }
  return { ok: true, schedule: [...schedule, { ...request }] };
}
