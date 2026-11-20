// Database work for workshops. Every query uses placeholders ($1, $2 ...),
// never text built from user input, so SQL injection is not possible.
const pool = require('../db/pool');
const { ApiError } = require('../middleware/errors');

// Turns a database row into the JSON shape in the API contract.
function toWorkshop(row) {
  return {
    workshopId: row.workshop_id,
    title: row.title,
    description: row.description,
    date: row.workshop_date,
    totalSeats: row.total_seats,
    seatsLeft: row.seats_left,
    organizerId: row.organizer_id,
    organizerName: row.organizer_name,
    createdAt: row.created_at
  };
}

async function createWorkshop(organizerId, w) {
  const { rows } = await pool.query(
    `INSERT INTO public.workshops (title, description, workshop_date, total_seats, seats_left, organizer_id)
     VALUES ($1, $2, $3, $4, $4, $5)
     RETURNING *`,
    [w.title, w.description, w.date, w.totalSeats, organizerId]
  );
  return toWorkshop(rows[0]);
}

async function listWorkshops() {
  const { rows } = await pool.query(
    `SELECT w.*, p.name AS organizer_name
     FROM public.workshops w
     JOIN public.profiles p ON p.id = w.organizer_id
     ORDER BY w.workshop_date ASC`
  );
  return rows.map(toWorkshop);
}

// Edit a workshop. Only its organizer may do this, and the new seat total
// cannot be lower than the number of people already registered.
async function updateWorkshop(workshopId, organizerId, w) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE locks this workshop row so no registration can sneak in mid-edit.
    const { rows } = await client.query(
      'SELECT * FROM public.workshops WHERE workshop_id = $1 FOR UPDATE',
      [workshopId]
    );
    if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Workshop not found.');
    const current = rows[0];
    if (current.organizer_id !== organizerId) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the organizer who created this workshop can edit it.');
    }

    const registered = current.total_seats - current.seats_left;
    if (w.totalSeats < registered) {
      throw new ApiError(409, 'SEATS_BELOW_REGISTERED',
        `${registered} people are already registered, so totalSeats cannot be lower than ${registered}.`);
    }

    const { rows: updated } = await client.query(
      `UPDATE public.workshops
       SET title = $1, description = $2, workshop_date = $3,
           total_seats = $4::int, seats_left = $4::int - $5::int
       WHERE workshop_id = $6
       RETURNING *`,
      [w.title, w.description, w.date, w.totalSeats, registered, workshopId]
    );
    await client.query('COMMIT');
    return toWorkshop(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createWorkshop, listWorkshops, updateWorkshop };
