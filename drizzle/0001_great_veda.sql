CREATE TABLE "trails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"author" text NOT NULL,
	"visibility" text DEFAULT 'personal' NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb,
	"forked_from_trail_id" uuid,
	"forked_from_step_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trails" ADD CONSTRAINT "trails_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;