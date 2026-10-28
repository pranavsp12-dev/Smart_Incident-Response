import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import apiRoutes from './routes/index.js';
import { requestLogger } from './middleware/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();

// Enable CORS for frontend integration (Next.js)
app.use(cors({
  origin: env.CORS_ORIGIN,
  credentials: true
}));

// Standard body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use(requestLogger);

// Mount main API routes
app.use('/api', apiRoutes);

// Fallback 404 handler for unknown routes
app.use(notFoundHandler);

// Central error handler
app.use(errorHandler);

export default app;
