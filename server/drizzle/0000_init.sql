CREATE TYPE "public"."game_mode" AS ENUM('competitive', 'unrated', 'private', 'bot');--> statement-breakpoint
CREATE TYPE "public"."game_type" AS ENUM('war', 'macao', 'texas_clinch', 'poker');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('waiting', 'in_progress', 'finished');--> statement-breakpoint
CREATE TYPE "public"."termination_reason" AS ENUM('all_cards', 'round_limit', 'timeout_forfeit', 'disconnect_forfeit', 'double_timeout', 'draw', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'moderator', 'admin');--> statement-breakpoint
CREATE TABLE "game_record_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"user_id" uuid,
	"final_rank" integer,
	"elo_before" integer,
	"elo_change" integer,
	CONSTRAINT "game_record_players_rank" CHECK ("game_record_players"."final_rank" >= 1)
);
--> statement-breakpoint
CREATE TABLE "game_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"game_type" "game_type" NOT NULL,
	"mode" "game_mode" NOT NULL,
	"state" jsonb NOT NULL,
	"termination_reason" "termination_reason",
	"winner_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "game_records_finished_consistency" CHECK (("game_records"."finished_at" is null) = ("game_records"."termination_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "game_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_type" "game_type" NOT NULL,
	"mode" "game_mode" NOT NULL,
	"status" "room_status" DEFAULT 'waiting' NOT NULL,
	"target_players" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"invite_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_rooms_invite_code_unique" UNIQUE("invite_code"),
	CONSTRAINT "game_rooms_target_players" CHECK ("game_rooms"."target_players" between 2 and 6)
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "room_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seat_index" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_players_room_user" UNIQUE("room_id","user_id"),
	CONSTRAINT "room_players_room_seat" UNIQUE("room_id","seat_index"),
	CONSTRAINT "room_players_seat_index" CHECK ("room_players"."seat_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_ratings" (
	"user_id" uuid NOT NULL,
	"game_type" "game_type" NOT NULL,
	"elo" integer DEFAULT 1000 NOT NULL,
	"games_played" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_ratings_user_id_game_type_pk" PRIMARY KEY("user_id","game_type"),
	CONSTRAINT "user_ratings_non_negative" CHECK ("user_ratings"."elo" >= 0 and "user_ratings"."games_played" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"is_banned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_length" CHECK (char_length("users"."username") between 3 and 20)
);
--> statement-breakpoint
ALTER TABLE "game_record_players" ADD CONSTRAINT "game_record_players_record_id_game_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."game_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_record_players" ADD CONSTRAINT "game_record_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_records" ADD CONSTRAINT "game_records_room_id_game_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."game_rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_records" ADD CONSTRAINT "game_records_winner_id_users_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rooms" ADD CONSTRAINT "game_rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_room_id_game_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."game_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ratings" ADD CONSTRAINT "user_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_record_players_user_idx" ON "game_record_players" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_record_players_record_idx" ON "game_record_players" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "game_records_type_mode_finished_idx" ON "game_records" USING btree ("game_type","mode","finished_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_ratings_leaderboard_idx" ON "user_ratings" USING btree ("game_type","elo" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));