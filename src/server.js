import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const server = buildApp().listen(config.port, () => console.log(`CanWeUseIt API listening on ${config.port}`));
process.on('SIGTERM', () => { server.close(() => pool.end()); });
