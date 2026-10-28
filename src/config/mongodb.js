import { MongoClient } from 'mongodb';
import { env } from './env.js';

let client = null;
let db = null;

/**
 * Connect to MongoDB instance using MONGO_URI from environment
 */
export async function connectMongo() {
  if (client && db) {
    return { client, db };
  }

  client = new MongoClient(env.MONGO_URI, {
    serverSelectionTimeoutMS: 3000 // 3 seconds timeout
  });

  await client.connect();
  db = client.db();
  return { client, db };
}

/**
 * Test MongoDB connectivity with a real ping command.
 * Only returns connected: true when ping command actually succeeds.
 */
export async function testMongoConnection() {
  try {
    const { db: connectedDb } = await connectMongo();
    await connectedDb.command({ ping: 1 });
    return {
      connected: true,
      message: 'MongoDB connection successful',
      databaseName: connectedDb.databaseName
    };
  } catch (error) {
    // Reset client reference if initial connection failed
    client = null;
    db = null;
    return {
      connected: false,
      message: 'MongoDB connection failed',
      error: error.message
    };
  }
}

/**
 * Access the active MongoDB database reference
 */
export function getMongoDb() {
  return db;
}

/**
 * Close active MongoDB connection
 */
export async function closeMongo() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
