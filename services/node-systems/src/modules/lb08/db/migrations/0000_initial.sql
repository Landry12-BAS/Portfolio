CREATE TABLE "lb08"."dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"node_id" text NOT NULL,
	"attempts" integer NOT NULL,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "lb08"."faults" (
	"root_run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"remaining" integer NOT NULL,
	CONSTRAINT "faults_root_run_id_node_id_pk" PRIMARY KEY("root_run_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "lb08"."outbox" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"root_run_id" uuid NOT NULL,
	"first_run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"connector" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "outbox_status_check" CHECK ("lb08"."outbox"."status" in ('pending', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE "lb08"."run_events" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"node_id" text,
	"data" jsonb NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "lb08"."run_steps" (
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_steps_run_id_node_id_pk" PRIMARY KEY("run_id","node_id"),
	CONSTRAINT "run_steps_status_check" CHECK ("lb08"."run_steps"."status" in ('pending', 'ready', 'queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "lb08"."runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"session_key" text NOT NULL,
	"root_run_id" uuid NOT NULL,
	"replay_of" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runs_status_check" CHECK ("lb08"."runs"."status" in ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "lb08"."sandbox_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"root_run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"connector" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_deliveries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "lb08"."stock_levels" (
	"sku" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"available_kg" numeric(10, 2) NOT NULL,
	"restock_eta_days" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lb08"."usage_counters" (
	"session_key" text NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "usage_counters_session_key_day_kind_pk" PRIMARY KEY("session_key","day","kind"),
	CONSTRAINT "usage_counters_kind_check" CHECK ("lb08"."usage_counters"."kind" in ('run', 'generation'))
);
--> statement-breakpoint
CREATE TABLE "lb08"."workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"origin" text NOT NULL,
	"description" text,
	"graph" jsonb NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_versions_origin_check" CHECK ("lb08"."workflow_versions"."origin" in ('generated', 'sample', 'edited'))
);
--> statement-breakpoint
CREATE TABLE "lb08"."workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_key" text NOT NULL,
	"name" text NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lb08"."dead_letters" ADD CONSTRAINT "dead_letters_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "lb08"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb08"."dead_letters" ADD CONSTRAINT "dead_letters_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lb08"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb08"."faults" ADD CONSTRAINT "faults_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "lb08"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb08"."outbox" ADD CONSTRAINT "outbox_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "lb08"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb08"."run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lb08"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb08"."run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lb08"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb08"."runs" ADD CONSTRAINT "runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "lb08"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb08"."sandbox_deliveries" ADD CONSTRAINT "sandbox_deliveries_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "lb08"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb08"."workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "lb08"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dead_letters_session_idx" ON "lb08"."dead_letters" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE INDEX "run_steps_status_idx" ON "lb08"."run_steps" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "runs_session_idx" ON "lb08"."runs" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE INDEX "runs_workflow_idx" ON "lb08"."runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "runs_root_idx" ON "lb08"."runs" USING btree ("root_run_id");--> statement-breakpoint
CREATE INDEX "sandbox_deliveries_session_idx" ON "lb08"."sandbox_deliveries" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_number_idx" ON "lb08"."workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflows_session_idx" ON "lb08"."workflows" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE INDEX "workflows_expires_idx" ON "lb08"."workflows" USING btree ("expires_at");