/** Snapshot file name: readable and filesystem-safe. */
export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'snapshot';
}

/** Absolute URLs pass through; relative ones resolve against `base`, keeping its path (e.g. Vite `base`). */
export function resolveUrl(url: string, base: string | undefined): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (!base) throw new Error(`Page URL "${url}" is relative; set \`vite\` or \`baseUrl\` in the config`);
  const root = base.endsWith('/') ? base : `${base}/`;
  return new URL(url.replace(/^\/+/, ''), root).href;
}
