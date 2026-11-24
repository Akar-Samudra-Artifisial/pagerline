import { existsSync } from 'node:fs'
import { defineConfig } from 'drizzle-kit'

if (!process.env.DATABASE_URL && existsSync('.env.local')) process.loadEnvFile('.env.local')

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set (see apps/server/.env.example)')

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
})
