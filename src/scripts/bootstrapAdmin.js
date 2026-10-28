import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pgPool } from '../config/postgres.js';
import { closeMongo } from '../config/mongodb.js';
import { bootstrapInitialAdmin } from '../services/users.service.js';

function askHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Admin bootstrap requires an interactive terminal for hidden password entry.');
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Admin bootstrap cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function run() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let admin;
  try {
    const name = (await terminal.question('Initial admin name: ')).trim();
    const email = (await terminal.question('Initial admin email: ')).trim().toLowerCase();
    terminal.close();

    const password = await askHidden('Initial admin password (hidden): ');
    const confirmation = await askHidden('Confirm password (hidden): ');
    if (password !== confirmation) {
      throw new Error('Passwords do not match.');
    }
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        email.length > 255 || password.length < 12 ||
        Buffer.byteLength(password, 'utf8') > 72) {
      throw new Error('Provide a name, valid email, and password of 12-72 UTF-8 bytes.');
    }

    admin = await bootstrapInitialAdmin({ name, email, password });
    console.log(`Created initial admin ${admin.email} (user ID ${admin.user_id}).`);
  } finally {
    terminal.close();
    await pgPool.end();
    await closeMongo();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`Admin bootstrap failed: ${error.message}`);
    process.exitCode = 1;
  });
}
