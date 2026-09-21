CREATE TABLE client_documents (
  client_id text PRIMARY KEY,
  schema_version integer NOT NULL,
  document jsonb NOT NULL,
  version text NOT NULL,
  blueprint_ref text NULL,
  overlay jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE client_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  version text NOT NULL,
  document jsonb NOT NULL,
  created_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, version)
);
CREATE TABLE client_secrets (
  client_id text NOT NULL,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, name)
);
