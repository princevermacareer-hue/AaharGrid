CREATE TABLE IF NOT EXISTS users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cognito_sub text UNIQUE NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('donor','recipient','volunteer','admin')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  organization text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  latitude double precision,
  longitude double precision,
  service_radius double precision NOT NULL DEFAULT 20,
  capacity double precision NOT NULL DEFAULT 0,
  categories text[] NOT NULL DEFAULT '{}',
  dietary text[] NOT NULL DEFAULT '{}',
  available_from timestamptz,
  available_until timestamptz,
  pickup_ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS listings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  donor_id integer NOT NULL REFERENCES users(id),
  title text NOT NULL,
  category text NOT NULL,
  dietary text NOT NULL,
  quantity double precision NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  prepared_at timestamptz NOT NULL,
  pickup_from timestamptz NOT NULL,
  pickup_until timestamptz NOT NULL,
  address text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  storage text NOT NULL,
  packaging text NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','picked_up','delivered','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pickup_until > pickup_from)
);
CREATE TABLE IF NOT EXISTS requests (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id integer NOT NULL REFERENCES listings(id),
  recipient_id integer NOT NULL REFERENCES users(id),
  quantity double precision NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','delivered')),
  received_quantity double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, recipient_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id integer NOT NULL UNIQUE REFERENCES requests(id),
  volunteer_id integer NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','accepted','picked_up','delivered','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pickup_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id integer NOT NULL REFERENCES assignments(id),
  actor_id integer NOT NULL REFERENCES users(id),
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  message text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id integer REFERENCES users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
