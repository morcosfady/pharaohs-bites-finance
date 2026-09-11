// `npm run demo` — visual check of every screen with fixture data, no Supabase.
import { defineConfig, mergeConfig } from "vite";
import path from "node:path";
import base from "./vite.config";

export default mergeConfig(base, defineConfig({
  resolve: { alias: [
    { find: /^(.*)\/hooks\/queries$/, replacement: path.resolve(__dirname, "src/test/mockQueries.ts") },
    { find: /^(.*)\/hooks\/useAuth$/, replacement: path.resolve(__dirname, "src/test/mockAuth.tsx") },
  ] },
  server: { port: 5174, strictPort: true },
}));
