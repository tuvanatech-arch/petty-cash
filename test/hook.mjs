// Resolves the CDN supabase import to a local mock for smoke tests.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(pathToFileURL('./loader.mjs'), import.meta.url);
