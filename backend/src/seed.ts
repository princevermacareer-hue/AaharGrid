import { pool } from './db.js';

if (process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Set ALLOW_DEMO_SEED=true to insert simulated records');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const donor = (await client.query(`INSERT INTO users(cognito_sub,name,role,status,organization,address) VALUES('demo-donor-not-a-login','Demo Donor','donor','approved','Demo Kitchen','New Delhi') ON CONFLICT (cognito_sub) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0];
  const recipient = (await client.query(`INSERT INTO users(cognito_sub,name,role,status,organization,address,latitude,longitude,service_radius,capacity,categories,dietary,available_from,available_until,pickup_ready)
    VALUES('demo-recipient-not-a-login','Demo Recipient','recipient','approved','Demo Community Group','New Delhi',28.61,77.21,20,50,ARRAY['Meals'],ARRAY['Vegetarian'],now(),now()+interval '7 days',true)
    ON CONFLICT (cognito_sub) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0];
  const volunteer = (await client.query(`INSERT INTO users(cognito_sub,name,role,status) VALUES('demo-volunteer-not-a-login','Demo Volunteer','volunteer','approved') ON CONFLICT (cognito_sub) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0];
  const exists = await client.query('SELECT 1 FROM listings WHERE donor_id=$1', [donor.id]);
  if (!exists.rowCount) {
    const listing = (await client.query(`INSERT INTO listings(donor_id,title,category,dietary,quantity,unit,prepared_at,pickup_from,pickup_until,address,latitude,longitude,storage,packaging,status)
      VALUES($1,'SIMULATED: community meal','Meals','Vegetarian',20,'kg',now(),now(),now()+interval '1 day','Simulated address, New Delhi',28.61,77.21,'Simulated handling','Sealed containers','reserved') RETURNING id`,[donor.id])).rows[0];
    const request = (await client.query("INSERT INTO requests(listing_id,recipient_id,quantity,status,received_quantity) VALUES($1,$2,20,'delivered',20) RETURNING id",[listing.id,recipient.id])).rows[0];
    const assignment = (await client.query("INSERT INTO assignments(request_id,volunteer_id,status) VALUES($1,$2,'delivered') RETURNING id",[request.id,volunteer.id])).rows[0];
    await client.query("INSERT INTO pickup_events(assignment_id,actor_id,status) VALUES($1,$2,'delivered')",[assignment.id,volunteer.id]);
    await client.query("UPDATE listings SET status='delivered' WHERE id=$1",[listing.id]);
    await client.query("INSERT INTO audit_logs(actor_id,action,entity,entity_id) VALUES($1,'simulated receipt','request',$2)",[recipient.id,request.id]);
  }
  await client.query('COMMIT');
  console.log('Simulated demonstration records inserted. These users cannot sign in.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
