import type { PageSnap, StorybookSource } from './config.js';

interface IndexEntry {
  id: string;
  type?: string;
  title?: string;
  name?: string;
}

/** Storybook 7+ `index.json` ({ entries }) or 6.x `stories.json` ({ stories }). */
export interface StorybookIndex {
  entries?: Record<string, IndexEntry>;
  stories?: Record<string, IndexEntry>;
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function matchesAny(value: string, globs: string[] | undefined): boolean {
  return (globs ?? []).some((g) => globToRegExp(g).test(value));
}

export function storiesFromIndex(index: StorybookIndex, source: StorybookSource): PageSnap[] {
  const base = source.url.replace(/\/+$/, '');
  const entries = Object.values(index.entries ?? index.stories ?? {});
  return entries
    .filter((e) => (e.type ?? 'story') === 'story')
    .filter((e) => !source.include?.length || matchesAny(e.id, source.include))
    .filter((e) => !matchesAny(e.id, source.exclude))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({
      name: e.id,
      url: `${base}/iframe.html?id=${encodeURIComponent(e.id)}&viewMode=story`,
      selector: source.selector ?? '#storybook-root',
      fullPage: false,
      ...(source.mask?.length ? { mask: source.mask } : {}),
      ...(source.ariaSnapshot !== undefined ? { ariaSnapshot: source.ariaSnapshot } : {}),
    }));
}

export async function fetchStorybookPages(source: StorybookSource): Promise<PageSnap[]> {
  const base = source.url.replace(/\/+$/, '');
  for (const file of ['index.json', 'stories.json']) {
    const res = await fetch(`${base}/${file}`).catch(() => undefined);
    if (res?.ok) return storiesFromIndex((await res.json()) as StorybookIndex, source);
  }
  throw new Error(`Could not read ${base}/index.json or ${base}/stories.json. Is Storybook running?`);
}
