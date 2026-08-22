// Facet derivation for the Plugins home section.
//
// The Home starter grid is organized around the artifact a user wants
// to make first:
//
//   Prototype · Slides
//
// Prototype and Slides have enough bundled templates to deserve a second
// row. Those child buckets follow the Feishu prompt taxonomy from the
// user-query analysis doc: business dashboards, app prototypes, landing
// pages, pitch decks, and training decks.
//
// Counts in each category reflect the catalog *as a whole*, not the
// post-filter slice. We deliberately avoid recomputing counts after
// a selection because per-axis counts that "go to zero" as the user
// clicks make the row visually noisy and obscure how the overall
// catalog is shaped.

import { resolveLocalizedText, type InstalledPluginRecord } from '@readable-studio/contracts';
import { localizedText } from './localization';

export type FacetAxis = 'category' | 'subcategory';

export interface FacetOption {
  slug: string;
  label: string;
  count: number;
  starterPrompt: string;
}

export interface FacetCatalog {
  category: FacetOption[];
  subcategory: Record<string, FacetOption[]>;
}

export interface FacetSelection {
  category: string | null;
  subcategory: string | null;
}

interface CategoryDef {
  slug: string;
  label: string;
  starterPrompt: string;
  test: (record: InstalledPluginRecord) => boolean;
}

interface SubcategoryDef extends CategoryDef {
  parent: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function manifestField(record: InstalledPluginRecord, key: string): string | undefined {
  const readable = (record.manifest?.readable ?? {}) as Record<string, unknown>;
  const v = readable[key];
  return typeof v === 'string' ? v : undefined;
}

function manifestTaskKind(record: InstalledPluginRecord): string | undefined {
  return manifestField(record, 'taskKind');
}

function manifestTagSlugs(record: InstalledPluginRecord): string[] {
  const raw = record.manifest?.tags ?? [];
  return raw.map((t) => slugify(String(t))).filter(Boolean);
}

function pipelineAtomSlugs(record: InstalledPluginRecord): string[] {
  const stages = record.manifest?.readable?.pipeline?.stages ?? [];
  return stages.flatMap((stage) => stage.atoms.map(slugify));
}

function recordSlugs(record: InstalledPluginRecord): Set<string> {
  return new Set([
    slugify(record.id),
    slugify(record.manifest?.name ?? ''),
    slugify(record.title ?? ''),
    slugify(manifestTaskKind(record) ?? ''),
    slugify(manifestField(record, 'mode') ?? ''),
    slugify(manifestField(record, 'scenario') ?? ''),
    slugify(manifestField(record, 'surface') ?? ''),
    ...manifestTagSlugs(record),
    ...pipelineAtomSlugs(record),
  ].filter(Boolean));
}

function byMode(mode: string): (record: InstalledPluginRecord) => boolean {
  return (record) => {
    const v = manifestField(record, 'mode');
    return typeof v === 'string' && slugify(v) === mode;
  };
}

function hasAnySlug(record: InstalledPluginRecord, slugs: readonly string[]): boolean {
  const haystack = recordSlugs(record);
  return slugs.some((slug) => haystack.has(slug));
}

function byAnySlug(...slugs: string[]): (record: InstalledPluginRecord) => boolean {
  return (record) => hasAnySlug(record, slugs);
}

// Curated artifact-kind list. Keep this aligned with the Home creation
// intents and the app's artifact product types.
const PRIMARY_CATEGORIES: readonly CategoryDef[] = [
  {
    slug: 'prototype',
    label: 'Prototype',
    starterPrompt: 'Create a Readable Studio plugin that generates an interactive prototype from a product brief.',
    test: byMode('prototype'),
  },
  {
    slug: 'deck',
    label: 'Slides',
    starterPrompt: 'Create a Readable Studio plugin that generates a polished slide deck from a narrative brief.',
    test: byMode('deck'),
  },
];

// Display-order overrides for sub-category rails/catalog, keyed by parent.
//
// IMPORTANT: this is presentation only. `extractSubcategories()` resolves a
// plugin's bucket via `SUBCATEGORIES.find(...)`, so the *array order* below is
// the matching precedence and must stay stable — reordering it would re-bucket
// overlapping-tag plugins (e.g. a `dashboard`+`design` plugin would flip from
// Dashboards to Brand / design). To change only the order chips/cards appear
// in — without touching which bucket a plugin lands in — list the parent's
// slugs here in the desired display order. Any slug not listed keeps its
// natural `SUBCATEGORIES` order behind the explicitly-ordered ones.
const SUBCATEGORY_DISPLAY_ORDER: Record<string, readonly string[]> = {
  prototype: [
    'landing-marketing',
    'brand-design',
    'business-dashboards',
    'app-prototypes',
    'developer-tools',
    'docs-reports',
  ],
  deck: [
    'creative-decks',
    'engineering-talks',
    'pitch-business',
    'course-training',
    'reports-briefings',
    'product-sales',
  ],
};

function orderSubcategoriesForDisplay(parent: string, options: FacetOption[]): FacetOption[] {
  const order = SUBCATEGORY_DISPLAY_ORDER[parent];
  if (!order) return options;
  const rank = (slug: string) => {
    const index = order.indexOf(slug);
    return index === -1 ? order.length : index;
  };
  // Stable sort: explicitly-ordered slugs float to the front in the configured
  // order; everything else keeps its original relative position behind them.
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option.slug) - rank(b.option.slug) || a.index - b.index)
    .map((entry) => entry.option);
}

// Scene child buckets based on the Feishu prompt taxonomy.
//
// NOTE: array order here is matching precedence (see SUBCATEGORY_DISPLAY_ORDER
// above), NOT the on-screen order. Keep it stable.
const SUBCATEGORIES: readonly SubcategoryDef[] = [
  {
    parent: 'prototype',
    slug: 'business-dashboards',
    label: 'Dashboards',
    starterPrompt: 'Create a Readable Studio prototype plugin for business systems, admin panels, or analytics dashboards.',
    test: byAnySlug(
      'dashboard',
      'admin-panel',
      'analytics',
      'control-panel',
      'team-dashboard',
      'live-dashboard',
      'refreshable-dashboard',
      'ops-dashboard',
      'github-dashboard',
      'social-media-dashboard',
      'data',
      'chart',
    ),
  },
  {
    parent: 'prototype',
    slug: 'app-prototypes',
    label: 'Apps',
    starterPrompt: 'Create a Readable Studio prototype plugin for multi-screen apps, onboarding, or task-productivity flows.',
    test: byAnySlug(
      'mobile',
      'app',
      'mobile-app',
      'ios-app',
      'android-app',
      'phone-screen',
      'app-ui',
      'app-mockup',
      'app-onboarding',
      'onboarding',
      'signup',
      'task',
      'habit-tracker',
      'dating-app',
    ),
  },
  {
    parent: 'prototype',
    slug: 'landing-marketing',
    label: 'Landing / marketing',
    starterPrompt: 'Create a Readable Studio prototype plugin for landing pages, marketing sites, pricing pages, or campaign pages.',
    test: byAnySlug(
      'landing',
      'landing-page',
      'saas-landing',
      'marketing-page',
      'product-landing',
      'pricing',
      'pricing-page',
      'waitlist-page',
      'coming-soon-page',
      'email-template',
      'newsletter',
      'lead-magnet',
      'e-guide',
      'poster',
      'social-carousel',
    ),
  },
  {
    parent: 'prototype',
    slug: 'developer-tools',
    label: 'Developer tools',
    starterPrompt: 'Create a Readable Studio prototype plugin for developer tools, engineering workflows, docs, or code collaboration.',
    test: byAnySlug(
      'engineering',
      'docs',
      'documentation',
      'api-reference',
      'runbook',
      'ops-doc',
      'sre-doc',
      'github',
      'linear',
      'issue',
    ),
  },
  {
    parent: 'prototype',
    slug: 'docs-reports',
    label: 'Docs / reports',
    starterPrompt: 'Create a Readable Studio prototype plugin for reports, documents, case studies, specs, invoices, or resumes.',
    test: byAnySlug(
      'report',
      'financial-report',
      'finance-report',
      'case-report',
      'clinical-case',
      'case-study',
      'guide',
      'tutorial',
      'pm-spec',
      'prd',
      'spec',
      'invoice',
      'resume',
      'cv',
    ),
  },
  {
    parent: 'prototype',
    slug: 'brand-design',
    label: 'Brand / design',
    starterPrompt: 'Create a Readable Studio prototype plugin for brand pages, visual exploration, design reviews, or mockups.',
    test: byAnySlug(
      'design',
      'design-review',
      'design-audit',
      'critique',
      'mockup',
      'wireframe',
      'visual',
      'brand',
    ),
  },
  {
    parent: 'deck',
    slug: 'pitch-business',
    label: 'Pitch / business',
    starterPrompt: 'Create a Readable Studio deck plugin for fundraising, business plans, investor decks, or strategic narratives.',
    test: byAnySlug(
      'pitch-deck',
      'pitch',
      'fundraising',
      'seed-round',
      'investor-deck',
      'vc-deck',
      'business-plan',
      'b2b-saas-pitch',
      'founder-vision-deck',
    ),
  },
  {
    parent: 'deck',
    slug: 'course-training',
    label: 'Course / training',
    starterPrompt: 'Create a Readable Studio deck plugin for courses, training materials, workshops, or classroom slides.',
    test: byAnySlug(
      'course-module',
      'course-slides',
      'training-deck',
      'workshop',
      'lesson',
      'education',
      'classroom',
    ),
  },
  {
    parent: 'deck',
    slug: 'reports-briefings',
    label: 'Reports / briefings',
    starterPrompt: 'Create a Readable Studio deck plugin for weekly reports, management briefings, white papers, or business reviews.',
    test: byAnySlug(
      'weekly-report',
      'status-update',
      'team-report',
      'business-review',
      'white-paper',
      'investment-thesis',
      'consulting-deliverable',
      'financial',
      'data-viz-launch',
    ),
  },
  {
    parent: 'deck',
    slug: 'product-sales',
    label: 'Product / sales',
    starterPrompt: 'Create a Readable Studio deck plugin for product launches, sales enablement, feature reveals, or customer pitches.',
    test: byAnySlug(
      'product-launch',
      'launch-deck',
      'feature-reveal',
      'launch-slides',
      'sales',
      'customer',
      'product',
    ),
  },
  {
    parent: 'deck',
    slug: 'engineering-talks',
    label: 'Engineering talks',
    starterPrompt: 'Create a Readable Studio deck plugin for technical presentations, architecture walkthroughs, or dev workflow talks.',
    test: byAnySlug(
      'engineering',
      'tech-sharing',
      'tech-talk',
      'technical-presentation',
      'system-design',
      'architecture',
      'developer-tutorial',
      'dev-workflow',
      'incident',
      'red-team',
      'risk-review',
    ),
  },
  {
    parent: 'deck',
    slug: 'creative-decks',
    label: 'Creative decks',
    starterPrompt: 'Create a Readable Studio deck plugin for creative, editorial, brand, social, or visual storytelling decks.',
    test: byAnySlug(
      'marketing',
      'editorial',
      'zhangzara',
      'creative-agency-pitch',
      'brand-manifesto',
      'fashion-brand-deck',
      'creator-portfolio',
      'xhs',
      'design-studio-deck',
    ),
  },
];

function extractPrimaryCategory(record: InstalledPluginRecord): string | null {
  return PRIMARY_CATEGORIES.find((c) => c.test(record))?.slug ?? null;
}

// Per-plugin category derivation. Returns at most one curated primary
// category, preserving display order.
export function extractCategories(record: InstalledPluginRecord): string[] {
  const primary = extractPrimaryCategory(record);
  return primary ? [primary] : [];
}

export function extractSubcategories(record: InstalledPluginRecord, parent?: string | null): string[] {
  const primary = parent ?? extractPrimaryCategory(record);
  if (!primary) return [];
  const match = SUBCATEGORIES.find((c) => c.parent === primary && c.test(record));
  return match ? [match.slug] : [];
}

export function buildCategoryCatalog(plugins: InstalledPluginRecord[]): FacetOption[] {
  const counts = new Map<string, number>();
  for (const p of plugins) {
    for (const slug of extractCategories(p)) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return PRIMARY_CATEGORIES.map((c) => ({
    slug: c.slug,
    label: c.label,
    starterPrompt: c.starterPrompt,
    count: counts.get(c.slug) ?? 0,
  }));
}

export function buildSubcategoryCatalog(plugins: InstalledPluginRecord[]): Record<string, FacetOption[]> {
  const counts = new Map<string, number>();
  for (const p of plugins) {
    const parent = extractPrimaryCategory(p);
    if (!parent) continue;
    for (const slug of extractSubcategories(p, parent)) {
      counts.set(`${parent}:${slug}`, (counts.get(`${parent}:${slug}`) ?? 0) + 1);
    }
  }
  return PRIMARY_CATEGORIES.reduce<Record<string, FacetOption[]>>((acc, category) => {
    const options = SUBCATEGORIES.filter((c) => c.parent === category.slug)
      .map((c) => ({
        slug: c.slug,
        label: c.label,
        starterPrompt: c.starterPrompt,
        count: counts.get(`${category.slug}:${c.slug}`) ?? 0,
      }));
    if (options.length > 0) {
      // Presentation order only; bucket membership is fixed by SUBCATEGORIES.
      acc[category.slug] = orderSubcategoriesForDisplay(category.slug, options);
    }
    return acc;
  }, {});
}

export function buildFacetCatalog(plugins: InstalledPluginRecord[]): FacetCatalog {
  return {
    category: buildCategoryCatalog(plugins),
    subcategory: buildSubcategoryCatalog(plugins),
  };
}

export function applyFacetSelection(
  plugins: InstalledPluginRecord[],
  selection: FacetSelection,
): InstalledPluginRecord[] {
  if (!selection.category) return plugins;
  const want = selection.category;
  const inCategory = plugins.filter((p) => extractCategories(p).includes(want));
  if (!selection.subcategory) return inCategory;
  return inCategory.filter((p) => extractSubcategories(p, want).includes(selection.subcategory!));
}

export function isFeaturedPlugin(record: InstalledPluginRecord): boolean {
  const readable = (record.manifest?.readable ?? {}) as Record<string, unknown>;
  return (
    readable.featured === true ||
    (typeof readable.featured === 'number' && Number.isFinite(readable.featured))
  );
}

// Free-text search across the obvious user-facing surface area: title,
// description, id, and tags. Composed with the category selection via
// AND inside the hook so the search narrows whatever the user has
// already filtered to. Multi-word queries are required to all match
// somewhere in the haystack so phrase fragments like "design slides"
// don't surface unrelated plugins.
export function filterByQuery(
  plugins: InstalledPluginRecord[],
  query: string,
  locale?: string,
): InstalledPluginRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return plugins;
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return plugins;
  return plugins.filter((p) => {
    const haystack = [
      p.title ?? '',
      resolveLocalizedText(localizedText(p.manifest?.title_i18n), locale),
      p.id,
      p.manifest?.description ?? '',
      resolveLocalizedText(localizedText(p.manifest?.description_i18n), locale),
      (p.manifest?.tags ?? []).join(' '),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

// Smart default selection. Lead with the first artifact kind in the
// Home creation flow while keeping all prototype scenes visible.
export const PREFERRED_DEFAULT_SELECTION: FacetSelection = {
  category: 'prototype',
  subcategory: null,
};

export function resolveDefaultSelection(catalog: FacetCatalog): FacetSelection {
  const wantCategory = PREFERRED_DEFAULT_SELECTION.category;
  const preferredCategory = wantCategory
    ? catalog.category.find((o) => o.slug === wantCategory && o.count > 0)
    : undefined;
  const selectedCategory = preferredCategory ?? catalog.category.find((o) => o.count > 0);
  if (!selectedCategory) return { category: null, subcategory: null };
  if (selectedCategory.slug !== wantCategory) {
    return { category: selectedCategory.slug, subcategory: null };
  }

  const wantSubcategory = PREFERRED_DEFAULT_SELECTION.subcategory;
  if (!wantSubcategory) return PREFERRED_DEFAULT_SELECTION;

  const hasSubcategoryWithPlugins = catalog.subcategory[wantCategory]?.some(
    (o) => o.slug === wantSubcategory && o.count > 0,
  );
  if (hasSubcategoryWithPlugins) return PREFERRED_DEFAULT_SELECTION;
  return { category: wantCategory, subcategory: null };
}
