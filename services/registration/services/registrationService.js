// Database work for registrations: the core business rules of this service.
const pool = require('../db/pool');
const { ApiError } = require('../middleware/errors');
const { promoteFromWaitlist } = require('./waitlistService');

// Register an attendee. Everything happens in ONE transaction:
// either all steps succeed, or nothing changes at all.
async function register(workshopId, attendeeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock the workshop row. If two people click "Register" for the last seat
    //    at the same moment, the second one waits here until the first finishes.
    const { rows } = await client.query(
      'SELECT workshop_date, seats_left FROM public.workshops WHERE workshop_id = $1 FOR UPDATE',
      [workshopId]
    );
    if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Workshop not found.');
    if (new Date(rows[0].workshop_date) <= new Date()) {
      throw new ApiError(400, 'WORKSHOP_STARTED', 'This workshop has already started.');
    }

    // 2. Already registered? (The UNIQUE rule in the table also guarantees this.)
    const dup = await client.query(
      'SELECT 1 FROM public.registrations WHERE workshop_id = $1 AND attendee_id = $2',
      [workshopId, attendeeId]
    );
    if (dup.rows.length > 0) {
      throw new ApiError(409, 'ALREADY_REGISTERED', 'You are already registered for this workshop.');
    }

    // 3. Take a seat, but only if one is left.
    const seat = await client.query(
      'UPDATE public.workshops SET seats_left = seats_left - 1 WHERE workshop_id = $1 AND seats_left > 0',
      [workshopId]
    );
    if (seat.rowCount === 0) {
      throw new ApiError(409, 'WORKSHOP_FULL', 'Sorry, this workshop is full. You can join the waiting list.');
    }

    // 4. Save the registration.
    const { rows: created } = await client.query(
      `INSERT INTO public.registrations (workshop_id, attendee_id)
       VALUES ($1, $2)
       RETURNING registration_id, workshop_id, attendee_id, created_at`,
      [workshopId, attendeeId]
    );

    // If this person was waiting in the queue, they no longer need their place.
    await client.query(
      'DELETE FROM public.waitlist WHERE workshop_id = $1 AND attendee_id = $2',
      [workshopId, attendeeId]
    );

    await client.query('COMMIT');
    const r = created[0];
    return {
      registrationId: r.registration_id,
      workshopId: r.workshop_id,
      attendeeId: r.attendee_id,
      registeredAt: r.created_at
    };
  } catch (err) {
    await client.query('ROLLBACK');
    // Safety net: the database's UNIQUE rule caught a duplicate.
    if (err.code === '23505') {
      throw new ApiError(409, 'ALREADY_REGISTERED', 'You are already registered for this workshop.');
    }
    throw err;
  } finally {
    client.release();
  }
}

// Cancel a registration and free the seat, in one transaction.
// If people are waiting, the first one in the queue gets the seat automatically.
async function cancel(registrationId, attendeeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Find the workshop first, then lock the WORKSHOP before the registration.
    // Every transaction here locks in the same order (workshop first), so two of
    // them can never wait for each other forever (no deadlock).
    const { rows: found } = await client.query(
      'SELECT workshop_id FROM public.registrations WHERE registration_id = $1',
      [registrationId]
    );
    if (found.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Registration not found.');
    await client.query(
      'SELECT 1 FROM public.workshops WHERE workshop_id = $1 FOR UPDATE',
      [found[0].workshop_id]
    );

    const { rows } = await client.query(
      'SELECT workshop_id, attendee_id FROM public.registrations WHERE registration_id = $1 FOR UPDATE',
      [registrationId]
    );
    if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Registration not found.');
    // Ownership check: you can only cancel YOUR OWN registration.
    if (rows[0].attendee_id !== attendeeId) {
      throw new ApiError(403, 'FORBIDDEN', 'You can only cancel your own registration.');
    }

    await client.query('DELETE FROM public.registrations WHERE registration_id = $1', [registrationId]);
    await client.query(
      'UPDATE public.workshops SET seats_left = seats_left + 1 WHERE workshop_id = $1',
      [rows[0].workshop_id]
    );
    // The freed seat goes to the first person in the queue, if there is one.
    const promoted = await promoteFromWaitlist(client, rows[0].workshop_id);
    await client.query('COMMIT');
    return {
      registrationId,
      workshopId: rows[0].workshop_id,
      status: 'cancelled',
      seatGivenToWaitlist: promoted.length > 0
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// The logged-in attendee's own registrations.
async function listMine(attendeeId) {
  const { rows } = await pool.query(
    `SELECT r.registration_id, r.created_at, w.workshop_id, w.title, w.workshop_date, w.seats_left
     FROM public.registrations r
     JOIN public.workshops w ON w.workshop_id = r.workshop_id
     WHERE r.attendee_id = $1
     ORDER BY w.workshop_date ASC`,
    [attendeeId]
  );
  return rows.map(r => ({
    registrationId: r.registration_id,
    registeredAt: r.created_at,
    workshop: { workshopId: r.workshop_id, title: r.title, date: r.workshop_date }
  }));
}

// Who registered for a workshop. Only that workshop's organizer may see this.
// The Attendance Service also uses this list to know who can be checked in.
async function listForWorkshop(workshopId, organizerId) {
  const w = await pool.query('SELECT organizer_id FROM public.workshops WHERE workshop_id = $1', [workshopId]);
  if (w.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Workshop not found.');
  if (w.rows[0].organizer_id !== organizerId) {
    throw new ApiError(403, 'FORBIDDEN', 'Only the organizer of this workshop can see who registered.');
  }
  const { rows } = await pool.query(
    `SELECT r.registration_id, r.attendee_id, r.created_at, p.name, u.email
     FROM public.registrations r
     JOIN public.profiles p ON p.id = r.attendee_id
     JOIN auth.users u ON u.id = r.attendee_id
     WHERE r.workshop_id = $1
     ORDER BY r.created_at ASC`,
    [workshopId]
  );
  return rows.map(r => ({
    registrationId: r.registration_id,
    attendeeId: r.attendee_id,
    name: r.name,
    email: r.email,
    registeredAt: r.created_at
  }));
}

module.exports = { register, cancel, listMine, listForWorkshop };
