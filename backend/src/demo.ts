import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

if (process.env.NODE_ENV === 'production') throw new Error('Demo mode is not permitted in production');
process.umask(0o077);
const directory = fileURLToPath(new URL('../.demo-data/', import.meta.url));
const dataDirectory = join(directory, 'postgres');
const passwordFile = join(directory, 'database-password');
await mkdir(directory, { recursive: true, mode: 0o700 });
let initialized = true;
try { await access(join(dataDirectory, 'PG_VERSION')); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  initialized = false;
}
let password: string;
if (initialized) {
  password = (await readFile(passwordFile, 'utf8')).trim();
  if (!password) throw new Error('Demo database password is empty');
} else {
  password = randomBytes(32).toString('hex');
  await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' });
}
const database = new EmbeddedPostgres({
  databaseDir: dataDirectory, user: 'aahargrid_demo', password, port: 55432,
  authMethod: 'scram-sha-256', persistent: true, autoRehydrateSymlinks: true,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${directory}`],
});
if (!initialized) await database.initialise();
await database.start();
const client = database.getPgClient('postgres', '127.0.0.1');
try {
  await client.connect();
  await client.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await client.query(`INSERT INTO users(cognito_sub,name,role,status,organization,address,latitude,longitude,service_radius,capacity,categories,dietary,available_from,available_until,pickup_ready)
    VALUES ('demo-donor-not-a-login','Demo Donor','donor','approved','Demo Kitchen','New Delhi',28.61,77.21,20,0,'{}','{}',NULL,NULL,false),
           ('demo-recipient-not-a-login','Demo Recipient','recipient','approved','Demo Community Group','New Delhi',28.61,77.21,20,50,ARRAY['Meals'],ARRAY['Vegetarian'],now(),now()+interval '30 days',true),
           ('demo-volunteer-not-a-login','Demo Volunteer','volunteer','approved','','New Delhi',NULL,NULL,20,0,'{}','{}',NULL,NULL,false),
           ('demo-admin-not-a-login','Demo Admin','admin','approved','','',NULL,NULL,20,0,'{}','{}',NULL,NULL,false)
    ON CONFLICT (cognito_sub) DO NOTHING`);
  if (!initialized) {
    await client.query(`INSERT INTO listings(donor_id,title,category,dietary,quantity,unit,prepared_at,pickup_from,pickup_until,address,latitude,longitude,storage,packaging)
      SELECT id,'SIMULATED: community meal','Meals','Vegetarian',20,'kg',now(),now(),now()+interval '7 days','Simulated address, New Delhi',28.61,77.21,'Keep refrigerated','Sealed containers'
      FROM users WHERE cognito_sub='demo-donor-not-a-login'`);
  }
} finally {
  await client.end();
}
const url = new URL('postgresql://127.0.0.1:55432/postgres');
url.username = 'aahargrid_demo';
url.password = password;
process.env.DATABASE_URL = url.toString();
process.env.DEMO_MODE = 'true';
await import('./index.js');
