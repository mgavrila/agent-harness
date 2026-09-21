CREATE TABLE "client_secrets" (
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_secrets_client_id_name_pk" PRIMARY KEY("client_id","name")
);
