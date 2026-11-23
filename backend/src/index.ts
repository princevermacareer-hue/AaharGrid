import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { z, ZodError } from 'zod';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { matchScore } from './matching.js';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './openapi.js';

const poolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID;
const domain = process.env.COGNITO_DOMAIN;
const demoMode = process.env.DEMO_MODE === 'true';
if (demoMode && process.env.NODE_ENV === 'production') throw new Error('Demo mode is not permitted in production');
if (!demoMode && (!poolId || !clientId || !domain)) throw new Error('COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID and COGNITO_DOMAIN are required');
const verifier = poolId && clientId ? CognitoJwtVerifier.create({ userPoolId: poolId, clientId, tokenUse: 'access' }) : null;
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:4200' }));
app.use(express.json({ limit: '32kb' }));
const apiSpec = openApiSpec(demoMode);
app.get('/openapi.json', (_req, res) => res.json(apiSpec));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(apiSpec));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 180 }));
app.get('/api/config', (_req, res) => res.json(demoMode ? { demo: true } : { demo: false, clientId, domain }));
app.get('/api/health', async (_req, res, next) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); } catch (e) { next(e); }
});

type User = { id: number; cognito_sub: string; role: 'donor' | 'recipient' | 'volunteer' | 'admin'; status: string };
type AuthRequest = Request & { sub?: string; user?: User };
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
const id = z.coerce.number().int().positive();
const text = z.string().trim().min(1).max(300);
const date = z.iso.datetime({ offset: true });
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const query = async (sql: string, values: unknown[] = []) => pool.query(sql, values);
const audit = (client: PoolClient, actor: number, action: string, entity: string, entityId: number) =>
  client.query('INSERT INTO audit_logs(actor_id,action,entity,entity_id) VALUES ($1,$2,$3,$4)', [actor, action, entity, entityId]);
const notify = (client: PoolClient, user: number, message: string) =>
  client.query('INSERT INTO notifications(user_id,message) VALUES ($1,$2)', [user, message]);
async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
app.use('/api', async (req: AuthRequest, _res, next) => {
  if (demoMode) {
    const role = req.get('x-demo-role');
    if (!role || !['donor','recipient','volunteer','admin'].includes(role)) return next(new HttpError(401, 'Select a demo role'));
    try {
      req.sub = `demo-${role}-not-a-login`;
      const result = await query('SELECT id,cognito_sub,role,status FROM users WHERE cognito_sub=$1', [req.sub]);
      if (!result.rows[0]) return next(new HttpError(503, 'Demo profile is unavailable'));
      req.user = result.rows[0];
      return next();
    } catch (error) { return next(error); }
  }
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return next(new HttpError(401, 'Sign in required'));
  let sub: string;
  try {
    if (!verifier) throw new Error('Cognito verifier is unavailable');
    const payload = await verifier.verify(token);
    sub = payload.sub;
  } catch { return next(new HttpError(401, 'Invalid or expired access token')); }
  try {
    req.sub = sub;
    const result = await query('SELECT id,cognito_sub,role,status FROM users WHERE cognito_sub=$1', [sub]);
    req.user = result.rows[0];
    next();
  } catch (error) { next(error); }
});
const registered = (req: AuthRequest): User => req.user ?? fail(403, 'Complete your profile first');
const allow = (req: AuthRequest, ...roles: User['role'][]): User => {
  const user = registered(req);
  if (user.status !== 'approved' || !roles.includes(user.role)) fail(403, 'Not authorized for this action');
  return user;
};
const endpoint = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };

app.get('/api/me', endpoint(async (req, res) => {
  if (!req.user) return res.json(null);
  const result = await query('SELECT id,name,role,status,organization,address,latitude,longitude,service_radius,capacity,categories,dietary,available_from,available_until,pickup_ready FROM users WHERE id=$1', [req.user.id]);
  return res.json(result.rows[0]);
}));
app.post('/api/me', endpoint(async (req, res) => {
  if (req.user) fail(409, 'Profile already exists');
  const data = z.object({ name: text, role: z.enum(['donor','recipient','volunteer']), organization: z.string().trim().max(300), address: z.string().trim().max(300) }).parse(req.body);
  if (data.role !== 'volunteer' && !data.organization) fail(400, 'Organization is required');
  const result = await transaction(async c => {
    const created = (await c.query('INSERT INTO users(cognito_sub,name,role,organization,address) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.sub, data.name, data.role, data.organization, data.address])).rows[0];
    await audit(c, created.id, 'registered', 'user', created.id);
    return created;
  });
  res.status(201).json(result);
}));
app.patch('/api/me', endpoint(async (req, res) => {
  const user = registered(req);
  const data = z.object({
    name: text, organization: z.string().trim().max(300), address: z.string().trim().max(300),
    latitude: latitude.nullable(), longitude: longitude.nullable(), service_radius: z.number().positive().max(1000),
    capacity: z.number().min(0), categories: z.array(text).max(30), dietary: z.array(text).max(30),
    available_from: date.nullable(), available_until: date.nullable(), pickup_ready: z.boolean()
  }).parse(req.body);
  if (data.available_from && data.available_until && Date.parse(data.available_until) <= Date.parse(data.available_from)) fail(400, 'Availability end must be after start');
  if ((user.role === 'donor' || user.role === 'recipient') && !data.organization) fail(400, 'Organization is required');
  await transaction(async c => {
    const current = (await c.query('SELECT organization FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
    if (user.status === 'approved' && user.role !== 'admin' && current.organization !== data.organization) fail(409, 'Contact an administrator to change your approved organization');
    await c.query(`UPDATE users SET name=$1,organization=$2,address=$3,latitude=$4,longitude=$5,service_radius=$6,capacity=$7,categories=$8,dietary=$9,available_from=$10,available_until=$11,pickup_ready=$12 WHERE id=$13`,
      [data.name,data.organization,data.address,data.latitude,data.longitude,data.service_radius,data.capacity,data.categories,data.dietary,data.available_from,data.available_until,data.pickup_ready,user.id]);
    await audit(c,user.id,'updated profile','user',user.id);
  });
  res.json({ ok: true });
}));

const listingSchema = z.object({
  title: text, category: text, dietary: text, quantity: z.number().positive().max(100000), unit: text,
  prepared_at: date, pickup_from: date, pickup_until: date, address: text,
  latitude, longitude, storage: text, packaging: text, safety_declaration: z.literal(true)
});
app.post('/api/listings', endpoint(async (req, res) => {
  const user = allow(req, 'donor');
  const l = listingSchema.parse(req.body);
  if (Date.parse(l.pickup_until) <= Math.max(Date.now(), Date.parse(l.pickup_from)) || Date.parse(l.prepared_at) > Date.parse(l.pickup_until)) fail(400, 'Invalid preparation or pickup times');
  const result = await transaction(async c => {
    const result = await c.query(`INSERT INTO listings(donor_id,title,category,dietary,quantity,unit,prepared_at,pickup_from,pickup_until,address,latitude,longitude,storage,packaging) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [user.id,l.title,l.category,l.dietary,l.quantity,l.unit,l.prepared_at,l.pickup_from,l.pickup_until,l.address,l.latitude,l.longitude,l.storage,l.packaging]);
    await audit(c,user.id,'created','listing',result.rows[0].id); return result.rows[0];
  });
  res.status(201).json(result);
}));
app.patch('/api/listings/:id', endpoint(async (req, res) => {
  const user = allow(req, 'donor'); const listingId = id.parse(req.params.id);
  const l = listingSchema.parse(req.body);
  if (Date.parse(l.pickup_until) <= Math.max(Date.now(), Date.parse(l.pickup_from)) || Date.parse(l.prepared_at) > Date.parse(l.pickup_until)) fail(400, 'Invalid preparation or pickup times');
  await transaction(async c => {
    const existing = (await c.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [listingId])).rows[0];
    if (!existing) fail(404, 'Listing not found');
    if (existing.donor_id !== user.id) fail(403, 'Not authorized');
    if (existing.status !== 'available' || (await c.query("SELECT 1 FROM requests WHERE listing_id=$1 AND status IN ('accepted','delivered')", [listingId])).rowCount) fail(409, 'Listing cannot be edited after allocation');
    await c.query(`UPDATE listings SET title=$1,category=$2,dietary=$3,quantity=$4,unit=$5,prepared_at=$6,pickup_from=$7,pickup_until=$8,address=$9,latitude=$10,longitude=$11,storage=$12,packaging=$13 WHERE id=$14`,
      [l.title,l.category,l.dietary,l.quantity,l.unit,l.prepared_at,l.pickup_from,l.pickup_until,l.address,l.latitude,l.longitude,l.storage,l.packaging,listingId]);
    const pending = await c.query("UPDATE requests SET status='rejected' WHERE listing_id=$1 AND status='pending' RETURNING recipient_id",[listingId]);
    for (const row of pending.rows) await notify(c,row.recipient_id,'A listing you requested was changed; the request was rejected.');
    await audit(c,user.id,'edited','listing',listingId);
  });
  res.json({ ok: true });
}));
app.get('/api/listings', endpoint(async (req, res) => {
  const user = allow(req, 'donor','recipient','admin');
  if (user.role === 'donor' || user.role === 'admin') {
    const result = await query(`SELECT l.*, GREATEST(l.quantity-COALESCE((SELECT SUM(r.quantity) FROM requests r WHERE r.listing_id=l.id AND r.status IN ('accepted','delivered')),0),0) AS remaining FROM listings l WHERE ($1::text='admin' OR l.donor_id=$2) ORDER BY l.created_at DESC`, [user.role,user.id]);
    return res.json(result.rows);
  }
  const recipient = (await query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
  const listings = await query(`SELECT l.id,l.title,l.category,l.dietary,l.unit,l.pickup_from,l.pickup_until,l.latitude,l.longitude,l.storage,l.packaging,l.prepared_at,l.status,l.quantity-COALESCE((SELECT SUM(r.quantity) FROM requests r WHERE r.listing_id=l.id AND r.status IN ('accepted','delivered')),0) AS quantity FROM listings l WHERE l.status='available' AND l.pickup_until>now()`);
  const matched = listings.rows.map(l => ({ ...l, score: matchScore(l, recipient) })).filter(l => l.score !== null && l.quantity > 0).sort((a,b) => b.score - a.score);
  return res.json(matched);
}));
app.get('/api/listings/:id/matches', endpoint(async (req,res) => {
  const user = allow(req,'donor','admin');
  const listingId = id.parse(req.params.id);
  const listing = (await query(`SELECT l.*,l.quantity-COALESCE((SELECT SUM(r.quantity) FROM requests r WHERE r.listing_id=l.id AND r.status IN ('accepted','delivered')),0) AS remaining FROM listings l WHERE l.id=$1`,[listingId])).rows[0];
  if (!listing) fail(404,'Listing not found');
  if (user.role !== 'admin' && listing.donor_id !== user.id) fail(403,'Not authorized');
  if (listing.remaining <= 0) return res.json([]);
  const recipients = await query("SELECT * FROM users WHERE role='recipient' AND status='approved' AND ($1::boolean OR cognito_sub <> 'demo-recipient-not-a-login')",[demoMode]);
  const matches = recipients.rows.flatMap(r => {
    const score = matchScore({ ...listing, quantity:listing.remaining },r);
    return score === null ? [] : [{ id:r.id, name:r.name, organization:r.organization, score }];
  }).sort((a,b) => b.score - a.score);
  return res.json(matches);
}));
app.patch('/api/listings/:id/close', endpoint(async (req, res) => {
  const user = allow(req,'donor','admin'); const listingId = id.parse(req.params.id);
  await transaction(async c => {
    const l = (await c.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [listingId])).rows[0];
    if (!l) fail(404,'Listing not found');
    if (user.role !== 'admin' && l.donor_id !== user.id) fail(403,'Not authorized');
    if (l.status !== 'available' || (await c.query("SELECT 1 FROM requests WHERE listing_id=$1 AND status='accepted'",[listingId])).rowCount) fail(409,'Listing cannot be closed with an active allocation');
    await c.query("UPDATE listings SET status='closed' WHERE id=$1",[listingId]);
    const pending = await c.query("UPDATE requests SET status='rejected' WHERE listing_id=$1 AND status='pending' RETURNING recipient_id",[listingId]);
    for (const row of pending.rows) await notify(c,row.recipient_id,'A listing you requested was closed.');
    await audit(c,user.id,'closed','listing',listingId);
  }); res.json({ ok:true });
}));
app.get('/api/requests', endpoint(async (req, res) => {
  const user = allow(req,'donor','recipient','admin');
  const result = await query(`SELECT r.*,l.title,l.unit,l.pickup_until,l.donor_id,u.organization AS recipient FROM requests r JOIN listings l ON l.id=r.listing_id JOIN users u ON u.id=r.recipient_id WHERE $1::text='admin' OR ($1='donor' AND l.donor_id=$2) OR ($1='recipient' AND r.recipient_id=$2) ORDER BY r.created_at DESC`,[user.role,user.id]);
  res.json(result.rows);
}));
app.post('/api/listings/:id/requests', endpoint(async (req, res) => {
  const user = allow(req,'recipient'); const listingId = id.parse(req.params.id);
  const { quantity } = z.object({ quantity:z.number().positive() }).parse(req.body);
  const result = await transaction(async c => {
    const l = (await c.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE',[listingId])).rows[0];
    if (!l) fail(404,'Listing not found');
    const r = (await c.query('SELECT * FROM users WHERE id=$1',[user.id])).rows[0];
    const allocated = Number((await c.query("SELECT COALESCE(SUM(quantity),0) AS total FROM requests WHERE listing_id=$1 AND status IN ('accepted','delivered')",[listingId])).rows[0].total);
    const remaining = l.quantity - allocated;
    if (quantity > remaining || matchScore({ ...l, quantity: remaining },r) === null) fail(409,'Listing is not eligible or quantity is unavailable');
    const created = (await c.query('INSERT INTO requests(listing_id,recipient_id,quantity) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[listingId,user.id,quantity])).rows[0];
    if (!created) fail(409,'You already requested this listing');
    await notify(c,l.donor_id,'A recipient requested your listing.');
    await audit(c,user.id,'requested','request',created.id); return created;
  }); res.status(201).json(result);
}));
app.patch('/api/requests/:id/decision', endpoint(async (req, res) => {
  const user = allow(req,'donor'); const requestId = id.parse(req.params.id);
  const { decision } = z.object({ decision:z.enum(['accepted','rejected']) }).parse(req.body);
  await transaction(async c => {
    const r = (await c.query('SELECT r.*,l.donor_id FROM requests r JOIN listings l ON l.id=r.listing_id WHERE r.id=$1',[requestId])).rows[0];
    if (!r) fail(404,'Request not found');
    if (r.donor_id !== user.id) fail(403,'Not authorized');
    const l = (await c.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE',[r.listing_id])).rows[0];
    const current = (await c.query('SELECT * FROM requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if (current.status !== 'pending') fail(409,'Request already decided');
    if (decision === 'accepted') {
      const total = Number((await c.query("SELECT COALESCE(SUM(quantity),0) AS total FROM requests WHERE listing_id=$1 AND status IN ('accepted','delivered')",[l.id])).rows[0].total);
      const recipient = (await c.query('SELECT * FROM users WHERE id=$1',[r.recipient_id])).rows[0];
      if (total + r.quantity > l.quantity || matchScore({ ...l, quantity: r.quantity }, recipient) === null) fail(409,'Food or recipient is no longer eligible');
      if (total + r.quantity >= l.quantity) await c.query("UPDATE listings SET status='reserved' WHERE id=$1",[l.id]);
    }
    await c.query('UPDATE requests SET status=$1 WHERE id=$2',[decision,requestId]);
    await notify(c,r.recipient_id,`Your request was ${decision}.`);
    await audit(c,user.id,decision,'request',requestId);
  }); res.json({ ok:true });
}));
app.get('/api/volunteers', endpoint(async (req,res) => {
  allow(req,'recipient','admin');
  res.json((await query("SELECT id,name FROM users WHERE role='volunteer' AND status='approved' AND ($1::boolean OR cognito_sub <> 'demo-volunteer-not-a-login') ORDER BY name",[demoMode])).rows);
}));
app.post('/api/assignments', endpoint(async (req,res) => {
  const user = allow(req,'recipient','admin');
  const data = z.object({ request_id:id, volunteer_id:id }).parse(req.body);
  const result = await transaction(async c => {
    const r = (await c.query('SELECT * FROM requests WHERE id=$1 FOR UPDATE',[data.request_id])).rows[0];
    if (!r) fail(404,'Request not found');
    if (user.role !== 'admin' && r.recipient_id !== user.id) fail(403,'Not authorized');
    if (r.status !== 'accepted') fail(409,'Request must be accepted');
    if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND role='volunteer' AND status='approved'",[data.volunteer_id])).rowCount) fail(400,'Volunteer is not approved');
    const a = (await c.query("INSERT INTO assignments(request_id,volunteer_id) VALUES($1,$2) ON CONFLICT (request_id) DO UPDATE SET volunteer_id=EXCLUDED.volunteer_id,status='assigned',created_at=now() WHERE assignments.status='failed' RETURNING id",[data.request_id,data.volunteer_id])).rows[0];
    if (!a) fail(409,'Request already assigned');
    await notify(c,data.volunteer_id,'You have a new pickup assignment.');
    await audit(c,user.id,'assigned','assignment',a.id); return a;
  }); res.status(201).json(result);
}));
app.get('/api/assignments', endpoint(async (req,res) => {
  const user = allow(req,'volunteer','recipient','admin');
  const result = await query(`SELECT a.*,l.title,l.address,l.pickup_until,r.recipient_id,r.quantity,l.unit,u.name AS volunteer FROM assignments a JOIN requests r ON r.id=a.request_id JOIN listings l ON l.id=r.listing_id JOIN users u ON u.id=a.volunteer_id WHERE $1::text='admin' OR ($1='volunteer' AND a.volunteer_id=$2) OR ($1='recipient' AND r.recipient_id=$2) ORDER BY a.created_at DESC`,[user.role,user.id]);
  res.json(result.rows);
}));
app.patch('/api/assignments/:id/status', endpoint(async (req,res) => {
  const user = allow(req,'volunteer'); const assignmentId = id.parse(req.params.id);
  const { status } = z.object({status:z.enum(['accepted','picked_up','delivered','failed'])}).parse(req.body);
  await transaction(async c => {
    const a = (await c.query('SELECT a.*,r.recipient_id,r.listing_id FROM assignments a JOIN requests r ON r.id=a.request_id WHERE a.id=$1 FOR UPDATE OF a',[assignmentId])).rows[0];
    if (!a) fail(404,'Assignment not found');
    if (a.volunteer_id !== user.id) fail(403,'Not authorized');
    const transitions: Record<string,string[]> = {assigned:['accepted','failed'],accepted:['picked_up','failed'],picked_up:['delivered','failed']};
    if (!transitions[a.status]?.includes(status)) fail(409,'Invalid pickup transition');
    await c.query('UPDATE assignments SET status=$1 WHERE id=$2',[status,assignmentId]);
    await c.query('INSERT INTO pickup_events(assignment_id,actor_id,status) VALUES($1,$2,$3)',[assignmentId,user.id,status]);
    await notify(c,a.recipient_id,`Pickup status: ${status.replace('_',' ')}.`);
    await audit(c,user.id,status,'assignment',assignmentId);
  }); res.json({ ok:true });
}));
app.post('/api/requests/:id/receipt', endpoint(async (req,res) => {
  const user = allow(req,'recipient'); const requestId = id.parse(req.params.id);
  const { quantity } = z.object({quantity:z.number().positive()}).parse(req.body);
  await transaction(async c => {
    const ref = (await c.query('SELECT listing_id FROM requests WHERE id=$1',[requestId])).rows[0];
    if (!ref) fail(404,'Request not found');
    await c.query('SELECT id FROM listings WHERE id=$1 FOR UPDATE',[ref.listing_id]);
    const r = (await c.query('SELECT r.*,l.donor_id FROM requests r JOIN listings l ON l.id=r.listing_id WHERE r.id=$1 FOR UPDATE OF r',[requestId])).rows[0];
    if (!r) fail(404,'Request not found');
    if (r.recipient_id !== user.id) fail(403,'Not authorized');
    if (r.status !== 'accepted' || quantity > r.quantity || !(await c.query("SELECT 1 FROM assignments WHERE request_id=$1 AND status='delivered'",[requestId])).rowCount) fail(409,'A delivered pickup and valid received quantity are required');
    await c.query("UPDATE requests SET status='delivered',received_quantity=$1 WHERE id=$2",[quantity,requestId]);
    await c.query(`UPDATE listings SET status='delivered' WHERE id=$1 AND status='reserved'
      AND NOT EXISTS (SELECT 1 FROM requests WHERE listing_id=$1 AND status='accepted')`,[r.listing_id]);
    await notify(c,r.donor_id,'A recipient confirmed delivery.');
    await audit(c,user.id,'confirmed receipt','request',requestId);
  }); res.json({ok:true});
}));
app.get('/api/notifications', endpoint(async (req,res) => {
  const user = registered(req); res.json((await query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[user.id])).rows);
}));
app.patch('/api/notifications/:id/read', endpoint(async (req,res) => {
  const user = registered(req); const result = await query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 RETURNING id',[id.parse(req.params.id),user.id]);
  if (!result.rowCount) fail(404,'Notification not found'); res.json({ok:true});
}));
app.get('/api/admin/users', endpoint(async (req,res) => {
  allow(req,'admin'); res.json((await query('SELECT id,name,role,status,organization,address FROM users ORDER BY created_at DESC')).rows);
}));
app.patch('/api/admin/users/:id', endpoint(async (req,res) => {
  const user = allow(req,'admin'); const target = id.parse(req.params.id);
  const { status } = z.object({status:z.enum(['approved','rejected'])}).parse(req.body);
  await transaction(async c => {
    const result = await c.query("UPDATE users SET status=$1 WHERE id=$2 AND role<>'admin' RETURNING id",[status,target]);
    if (!result.rowCount) fail(404,'User not found');
    await notify(c,target,`Your application profile was ${status}.`); await audit(c,user.id,status,'user',target);
  }); res.json({ok:true});
}));
app.get('/api/admin/audit-logs', endpoint(async (req,res) => {
  allow(req,'admin'); res.json((await query('SELECT a.*,u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 200')).rows);
}));
app.get('/api/analytics/overview', endpoint(async (req,res) => {
  const user = allow(req,'donor','recipient','volunteer','admin');
  const result = await query(`SELECT COUNT(*)::int AS requests,COUNT(*) FILTER (WHERE r.status='pending')::int AS pending, COUNT(*) FILTER (WHERE r.status='delivered')::int AS completed FROM requests r JOIN listings l ON l.id=r.listing_id WHERE $1::text='admin' OR ($1='donor' AND l.donor_id=$2) OR ($1='recipient' AND r.recipient_id=$2) OR ($1='volunteer' AND EXISTS (SELECT 1 FROM assignments a WHERE a.request_id=r.id AND a.volunteer_id=$2))`,[user.role,user.id]);
  res.json(result.rows[0]);
}));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid input', details: err.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error('Request failed:', err instanceof Error ? err.message : 'unknown error');
  return res.status(500).json({ error: 'Unexpected server error' });
});
const port = Number(process.env.PORT || 3000);
if (demoMode) {
  app.listen(port, '127.0.0.1', () => console.log(`AaharGrid API listening on ${port} (LOCAL DEMO: AUTHENTICATION DISABLED)`));
} else {
  app.listen(port, () => console.log(`AaharGrid API listening on ${port}`));
}
