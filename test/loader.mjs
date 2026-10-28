import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.includes('@supabase/supabase-js')) {
    return { url: pathToFileURL(new URL('./mock-supabase.mjs', import.meta.url).pathname).href, shortCircuit: true };
  }
  return next(specifier, context);
}
