require('dotenv').config();

const express = require('express');
const { checkConnection } = require('./db');
const { webhookRouter } = require('./routes/webhook');

const app = express();
const PORT = process.env.PORT || 3400;

// Parse JSON bodies — VAPI sends JSON webhooks
app.use(express.json({ limit: '5mb' }));

// Health check
app.get('/health', async (_req, res) => {
  const dbStatus = await checkConnection();
  const status = dbStatus.connected ? 200 : 503;
  res.status(status).json({
    service: 'vapi-webhook-server',
    status: dbStatus.connected ? 'healthy' : 'degraded',
    db: dbStatus,
    uptime: process.uptime(),
  });
});

// VAPI webhook route
app.use('/webhook', webhookRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[vapi-webhook-server] listening on :${PORT}`);
});

module.exports = { app };
