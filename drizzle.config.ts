import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './packages/shared/src/schema/index.ts',
  out: './packages/shared/drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.POSTGRES_URL ?? 'postgresql://openbrain:openbrain_dev@localhost:5432/openbrain',
  },
  verbose: true,
  strict: true,
})
