-- Additive migration. Existing visibility and identity records keep their meaning.
ALTER TABLE ispace.apps DROP CONSTRAINT apps_visibility_check;
ALTER TABLE ispace.apps ADD CONSTRAINT apps_visibility_check CHECK (visibility IN ('private', 'shared', 'public', 'link'));
ALTER TABLE ispace.backends DROP CONSTRAINT backends_visibility_check;
ALTER TABLE ispace.backends ADD CONSTRAINT backends_visibility_check CHECK (visibility IN ('private', 'shared', 'public', 'link'));

CREATE TABLE ispace.external_identities (
  provider text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);

-- Browser-bound, single-use login attempts work across replicas and restarts.
CREATE TABLE ispace.oauth_states (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  provider text NOT NULL,
  context jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_states_expiry_idx ON ispace.oauth_states(expires_at);
