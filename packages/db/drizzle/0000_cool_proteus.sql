CREATE TYPE "public"."label_kind" AS ENUM('cex_hot', 'cex_cold', 'cex_deposit', 'dex_router', 'dex_pool', 'dex_singleton');--> statement-breakpoint
CREATE TABLE "addresses" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"is_contract" boolean NOT NULL,
	"nonce" bigint NOT NULL,
	"primary_name" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "addresses_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE TABLE "bindings" (
	"namespace" text NOT NULL,
	"name_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"verified" boolean NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "bindings_namespace_name_id_chain_id_address_valid_from_key" UNIQUE NULLS NOT DISTINCT("namespace","name_id","chain_id","address","valid_from")
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"source" text NOT NULL,
	"kind" "label_kind" NOT NULL,
	"entity" text NOT NULL,
	"confidence" real NOT NULL,
	"source_url" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "labels_chain_id_address_source_pk" PRIMARY KEY("chain_id","address","source")
);
--> statement-breakpoint
CREATE TABLE "maps" (
	"params_hash" text PRIMARY KEY NOT NULL,
	"graph_json" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "names" (
	"namespace" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"parent_ids" text[] NOT NULL,
	"registry" text,
	"owner" text,
	"resolver" text,
	"registered_at" timestamp with time zone,
	"expiry" timestamp with time zone,
	CONSTRAINT "names_namespace_id_pk" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"chain_id" integer NOT NULL,
	"token" text NOT NULL,
	"hour_bucket" timestamp with time zone NOT NULL,
	"usd" double precision,
	CONSTRAINT "prices_chain_id_token_hour_bucket_pk" PRIMARY KEY("chain_id","token","hour_bucket")
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"last_block" bigint NOT NULL,
	"truncated" boolean NOT NULL,
	CONSTRAINT "sync_cursors_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"chain_id" integer NOT NULL,
	"unique_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"block" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text,
	"asset" text NOT NULL,
	"raw_value" numeric(78, 0) NOT NULL,
	"decimals" integer,
	"category" text NOT NULL,
	CONSTRAINT "transfers_chain_id_unique_id_pk" PRIMARY KEY("chain_id","unique_id")
);
--> statement-breakpoint
CREATE INDEX "transfers_chain_id_from_address_block_idx" ON "transfers" USING btree ("chain_id","from_address","block");