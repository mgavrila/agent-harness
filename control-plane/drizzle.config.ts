import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './src/domain/db/schema.ts', out: './drizzle' });
