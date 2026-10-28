import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export const env = {
  PORT: process.env.PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
  JWT_SECRET: process.env.JWT_SECRET || '',

  // PostgreSQL Configuration (Relational store)
  PG: {
    HOST: process.env.PG_HOST || 'localhost',
    PORT: Number(process.env.PG_PORT) || 5432,
    DATABASE: process.env.PG_DATABASE || 'smart_incident',
    USER: process.env.PG_USER || 'postgres',
    PASSWORD: process.env.PG_PASSWORD || ''
  },

  // MongoDB Configuration (Document store)
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/smart_incident_logs'
};
