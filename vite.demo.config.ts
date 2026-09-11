// `npm run demo` — every screen backed by an in-browser database (src/test/mockSupabase.ts).
// Edits work and persist in localStorage; no Supabase needed.
import { defineConfig, mergeConfig } from "vite";
import path from "node:path";
import base from "./vite.config";

export default mergeConfig(base, defineConfig({
  resolve: { alias: [
    { find: /^(.*)\/lib\/supabase$/, replacement: path.resolve(__dirname, "src/test/mockSupabase.ts") },
    { find: /^(.*)\/hooks\/useAuth$/, replacement: path.resolve(__dirname, "src/test/mockAuth.tsx") },
  ] },
  server: { port: 5174, strictPort: true },
}));
