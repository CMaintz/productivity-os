// @ts-check
import { defineConfig } from 'astro/config';

// Static site: all data comes from Supabase in the browser, behind GitHub sign-in and RLS.
export default defineConfig({
  site: 'https://dash.maintz.dev',
  output: 'static',
  devToolbar: { enabled: false },
});
