import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";
import { logger } from "./logger.js";

let cachedClient: SupabaseClient<Database> | null = null;

export function getSupabaseClient(
  supabaseUrl?: string,
  supabaseServiceRoleKey?: string,
) {
  const url = supabaseUrl || process.env.SUPABASE_URL?.trim();
  const key =
    supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url) {
    logger.error("Failed to create Supabase client", {
      reason: "Missing SUPABASE_URL",
    });
    throw new Error("Missing SUPABASE_URL");
  }

  if (!key) {
    logger.error("Failed to create Supabase client", {
      reason: "Missing SUPABASE_SERVICE_ROLE_KEY",
    });
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  if (!cachedClient) {
    logger.info("Creating Supabase client", { url });
    cachedClient = createClient<Database>(url, key);
  }

  return cachedClient;
}
