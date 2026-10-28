import dotenv from "dotenv";
import { z } from "zod";

// Load environment variables (.env.production takes precedence if NODE_ENV === "production")
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env.production" });
}
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z
    .string({
      required_error: "DATABASE_URL is required. Please set it in your environment or backend/.env file."
    })
    .min(1, "DATABASE_URL cannot be empty")
    .refine(
      (url) => url.startsWith("postgres://") || url.startsWith("postgresql://"),
      "DATABASE_URL must be a valid PostgreSQL connection string starting with postgres:// or postgresql://"
    ),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: z
    .enum(["true", "false", "require", "disable"])
    .optional()
    .transform((val) => {
      if (val === "true" || val === "require") return true;
      if (val === "false" || val === "disable") return false;
      return undefined;
    }),
  // Firebase Admin SDK Configuration (Optional in local dev, required for live verification)
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional()
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `  - ${err.path.join(".")}: ${err.message}`)
      .join("\n");

    const formattedError = `\n======================================================\n` +
      `[FATAL] Backend Configuration Error: Invalid or missing environment variables:\n` +
      `${errorMessages}\n` +
      `======================================================\n`;

    console.error(formattedError);
    throw new Error(`Environment validation failed:\n${errorMessages}`);
  }

  return result.data;
}

export const env = loadEnv();
