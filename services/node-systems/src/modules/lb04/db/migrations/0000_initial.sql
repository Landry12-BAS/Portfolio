CREATE TABLE "lb04"."contract_files" (
	"contract_id" uuid PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lb04"."contract_pages" (
	"contract_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "contract_pages_contract_id_page_pk" PRIMARY KEY("contract_id","page"),
	CONSTRAINT "contract_pages_page_check" CHECK ("lb04"."contract_pages"."page" between 1 and 30)
);
--> statement-breakpoint
CREATE TABLE "lb04"."contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_key" text NOT NULL,
	"origin" text NOT NULL,
	"sample_id" text,
	"title" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"failure_code" text,
	"pages" integer,
	"working" jsonb,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"redlines_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contracts_origin_check" CHECK ("lb04"."contracts"."origin" in ('upload', 'sample')),
	CONSTRAINT "contracts_sample_check" CHECK (("lb04"."contracts"."origin" = 'sample') = ("lb04"."contracts"."sample_id" is not null)),
	CONSTRAINT "contracts_state_check" CHECK ("lb04"."contracts"."state" in ('queued', 'extracting', 'analysing', 'verifying', 'done', 'failed')),
	CONSTRAINT "contracts_failure_check" CHECK (("lb04"."contracts"."state" = 'failed') = ("lb04"."contracts"."failure_code" is not null)),
	CONSTRAINT "contracts_redlines_check" CHECK ("lb04"."contracts"."redlines_used" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "lb04"."redlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"finding_id" text NOT NULL,
	"redline" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lb04"."reports" (
	"contract_id" uuid PRIMARY KEY NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lb04"."usage_counters" (
	"session_key" text NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "usage_counters_session_key_day_kind_pk" PRIMARY KEY("session_key","day","kind"),
	CONSTRAINT "usage_counters_kind_check" CHECK ("lb04"."usage_counters"."kind" in ('contract', 'upload'))
);
--> statement-breakpoint
ALTER TABLE "lb04"."contract_files" ADD CONSTRAINT "contract_files_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "lb04"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb04"."contract_pages" ADD CONSTRAINT "contract_pages_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "lb04"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb04"."redlines" ADD CONSTRAINT "redlines_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "lb04"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb04"."reports" ADD CONSTRAINT "reports_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "lb04"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contracts_session_idx" ON "lb04"."contracts" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE INDEX "contracts_expires_idx" ON "lb04"."contracts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "contracts_state_idx" ON "lb04"."contracts" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "redlines_finding_idx" ON "lb04"."redlines" USING btree ("contract_id","finding_id");