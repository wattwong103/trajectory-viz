/**
 * usePois — POI categories + points for the map's context layer
 * (universal-trajectory-support Phase 2).
 *
 * Categories are fetched once on mount. Points are refetched whenever the
 * enabled-category set changes, debounced ~300 ms so rapid chip toggling
 * coalesces into one round of requests. One request per enabled category
 * (the API filters a single category per call); results are flattened and
 * deduped by (source_key, poi_id) — poi_id is a per-ingest row_number and
 * can collide across POI sources.
 *
 * The enabled set is expressed as a DISABLED list (default = all enabled) so
 * the URL hash stays clean — mirrors the hs= hidden-sources approach. The
 * hook owns that list (seeded from `initialDisabled`, e.g. decoded from the
 * hash) and reports every change via `onDisabledChange` so the owner can
 * persist it.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { fetchPois, fetchPoiCategories } from '../api';
import type { Poi, PoiCategory } from '../types';

const POI_FETCH_DEBOUNCE_MS = 300;
const POI_CATEGORY_LIMIT = 20000;

interface UsePoisOptions {
  initialDisabled?: string[];
  onDisabledChange?: (disabled: string[]) => void;
}

export function usePois(options: UsePoisOptions = {}) {
  const { initialDisabled, onDisabledChange } = options;
  const [categories, setCategories] = useState<PoiCategory[]>([]);
  const [pois, setPois] = useState<Poi[]>([]);
  const [disabled, setDisabled] = useState<string[]>(initialDisabled ?? []);
  const [loading, setLoading] = useState(false);

  // Stable callback ref — toggleCategory/setAll must not be rebuilt (and
  // retrigger effects) when the parent's inline lambda re-renders.
  const onDisabledChangeRef = useRef(onDisabledChange);
  onDisabledChangeRef.current = onDisabledChange;

  // Fetch the category catalogue once. Failure degrades to "no POI layer"
  // (empty categories hide the FilterPanel section and the map layer).
  useEffect(() => {
    let cancelled = false;
    fetchPoiCategories()
      .then(res => { if (!cancelled) setCategories(res.categories); })
      .catch(e => console.error('POI categories fetch failed:', e));
    return () => { cancelled = true; };
  }, []);

  // Categories arrive one row per (source_key, category); the enabled set is
  // keyed by category NAME, so duplicate names across sources toggle together.
  const allCategories = useMemo(
    () => [...new Set(categories.map(c => c.category))].sort(),
    [categories],
  );

  const enabledCategories = useMemo(
    () => allCategories.filter(c => !disabled.includes(c)),
    [allCategories, disabled],
  );

  // Debounced refetch on enabled-set change. Joined key: array identity would
  // re-run the effect on every render.
  const enabledKey = enabledCategories.join(',');
  useEffect(() => {
    if (categories.length === 0) return;      // catalogue not loaded yet
    if (enabledCategories.length === 0) {
      setPois([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      Promise.all(
        enabledCategories.map(category =>
          fetchPois({ category, limit: POI_CATEGORY_LIMIT }),
        ),
      )
        .then(responses => {
          if (cancelled) return;
          const seen = new Set<string>();
          const merged: Poi[] = [];
          for (const res of responses) {
            for (const p of res.pois) {
              const key = `${p.source_key}:${p.poi_id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(p);
            }
          }
          setPois(merged);
        })
        .catch(e => {
          if (!cancelled) console.error('POI fetch failed:', e);
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, POI_FETCH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
    // Joined key: array identity would re-run the effect on every render
    // (same convention as useInsights' transportModes?.join(',')).
  }, [enabledKey, categories.length]);

  // Report disabled-list changes to the owner (hash persistence) via an
  // effect, NOT inside the setState updaters — updaters may run during
  // render and be double-invoked in StrictMode.
  const isFirstSync = useRef(true);
  useEffect(() => {
    if (isFirstSync.current) { isFirstSync.current = false; return; }
    onDisabledChangeRef.current?.(disabled);
  }, [disabled]);

  const toggleCategory = useCallback((category: string) => {
    setDisabled(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category],
    );
  }, []);

  const setAll = useCallback((enabled: boolean) => {
    setDisabled(enabled ? [] : [...allCategories]);
  }, [allCategories]);

  return { pois, categories, enabledCategories, disabledCategories: disabled,
           toggleCategory, setAll, loading };
}
