// Loads .env before anything else reads process.env.
// Dependency-free so it works on any Node >= 18 without CLI flags.
import fs from 'fs';
import path from 'path';

const file = path.join(process.cwd(), '.env');
if (fs.existsSync(file)) {
  for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val !== '' && process.env[key] === undefined) process.env[key] = val;
  }
}
