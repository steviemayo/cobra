import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '../../.env', quiet: true });

// `prisma generate` never connects; the placeholder keeps lint/typecheck/CI working without secrets.
// Migrations need the real DIRECT_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.DIRECT_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
