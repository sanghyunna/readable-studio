import { useEffect, useState } from 'react';
import type { SystemFontFamily } from '@readable-studio/contracts';
import { fetchSystemFonts } from '../providers/registry';

// Module-level promise cache: the font list is fetched once and shared by
// every picker instance. fetchSystemFonts never throws (returns [] on
// error), so a failure is cached as an empty list.
// ponytail: no retry after a failed load; add one only if fonts install
// mid-session and users complain the picker never picks them up.
let systemFontsPromise: Promise<SystemFontFamily[]> | null = null;

function loadSystemFonts(): Promise<SystemFontFamily[]> {
  if (!systemFontsPromise) systemFontsPromise = fetchSystemFonts();
  return systemFontsPromise;
}

export function useSystemFonts(): { families: SystemFontFamily[]; loading: boolean } {
  const [families, setFamilies] = useState<SystemFontFamily[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    loadSystemFonts().then((list) => {
      if (!alive) return;
      setFamilies(list);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { families, loading };
}
