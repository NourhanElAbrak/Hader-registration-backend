// The Express application. Used by server.js (on your laptop) and lambda.js (in AWS).
const express = require('express');
const pool = require('./db/pool');
const { notFoundRoute, errorHandler } = require('./middleware/errors');

const app = express();

// CORS: only our own frontend may call this API from a browser.
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10kb' }));

// Health check: proves the API is running AND can reach the database.
app.get('/health', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS workshops FROM public.workshops');
    res.json({ status: 'ok', database: 'connected', workshops: rows[0].workshops });
  } catch (err) {
    next(err);
  }
});

// The service's routes. Express 5 sends any error thrown in them to errorHandler.
app.use('/me', require('./routes/me'));
app.use('/workshops', require('./routes/workshops'));
app.use('/registrations', require('./routes/registrations'));

app.use(notFoundRoute);
app.use(errorHandler);

module.exports = app;
